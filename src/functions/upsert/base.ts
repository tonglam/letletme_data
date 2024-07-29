import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../index';
import { errorLogger } from '../../utils/logger.util';

interface ListCollectionsResult {
  cursor: {
    firstBatch: Array<{ name: string }>;
    id: number;
    ns: string;
  };
  ok: number;
}

interface CreateManyResult {
  ok: number;
  n: number;
}

interface UpdateManyResult {
  ok: number;
  n: number;
  nModified: number;
}

const handleZodError = (error: z.ZodError): string => {
  const errorMessage = error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ');
  errorLogger({ message: `Error validating data: ${errorMessage}` });
  return errorMessage;
};

const parseData = <T extends z.ZodTypeAny>(
  inputData: unknown,
  schema: T,
): { success: boolean; data?: z.infer<T>[]; error?: string } => {
  try {
    const data = schema.array().parse(inputData);
    return { success: true, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessage = handleZodError(error);
      return { success: false, error: errorMessage };
    }
    return { success: false, error: 'Unknown error during data parsing' };
  }
};

const collectionExists = async (collectionName: string): Promise<boolean> => {
  try {
    const result = await prisma.$runCommandRaw({
      listCollections: 1,
      filter: { name: collectionName },
    });

    const typedResult = result as unknown as ListCollectionsResult;

    return typedResult.cursor.firstBatch.length > 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error checking if collection ${collectionName} exists: ${errorMessage}`);
    throw error;
  }
};

const safeDelete = async (collectionName: string): Promise<void> => {
  try {
    const exists = await collectionExists(collectionName);
    if (!exists) {
      console.log(`Collection ${collectionName} does not exist. Skipping delete operation.`);
      return;
    }

    await prisma.$runCommandRaw({
      delete: collectionName,
      deletes: [{ q: {}, limit: 0 }],
    });
    console.log(`Successfully deleted all documents from ${collectionName}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error while deleting ${collectionName} collection: ${errorMessage}`);
    throw error;
  }
};

const safeCreateMany = async <T extends Prisma.JsonObject>(
  collectionName: string,
  documents: T[],
): Promise<number> => {
  try {
    if (documents.length === 0) {
      console.log(`No documents to insert into ${collectionName}. Skipping insert operation.`);
      return 0;
    }

    const result = await prisma.$runCommandRaw({
      insert: collectionName,
      documents: documents as unknown as Prisma.InputJsonObject,
      ordered: false,
    });

    const typedResult = result as unknown as CreateManyResult;

    if (typedResult.ok !== 1) {
      throw new Error(`Bulk insert operation failed for collection ${collectionName}`);
    }

    console.log(`Successfully inserted ${typedResult.n} documents into ${collectionName}`);
    return typedResult.n;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `Error while inserting documents into ${collectionName} collection: ${errorMessage}`,
    );
    throw error;
  }
};

const safeUpdateMany = async (
  collectionName: string,
  filter: Prisma.JsonObject,
  update: Prisma.JsonObject,
): Promise<number> => {
  try {
    const exists = await collectionExists(collectionName);
    if (!exists) {
      console.log(`Collection ${collectionName} does not exist. Skipping update operation.`);
      return 0;
    }

    const result = await prisma.$runCommandRaw({
      update: collectionName,
      updates: [
        {
          q: filter,
          u: { $set: update },
          multi: true,
        },
      ],
    });

    const typedResult = result as unknown as UpdateManyResult;

    if (typedResult.ok !== 1) {
      throw new Error(`Bulk update operation failed for collection ${collectionName}`);
    }

    console.log(`Successfully updated ${typedResult.n} documents in ${collectionName}`);
    return typedResult.nModified;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `Error while updating documents in ${collectionName} collection: ${errorMessage}`,
    );
    throw error;
  }
};

/**
 * 1. validate the data using the zod schema
 * 2. map the data to the prisma schema
 * 3. delete all the existing data
 * 4. insert the new data
 */

const truncate_insert = async <T extends z.ZodTypeAny, M extends object>(
  inputData: unknown,
  schema: T,
  mapToPrismaDataCallBack: (data: z.infer<T>) => M,
  truncateData: () => Promise<void>,
  insertData: (data: M[]) => Promise<void>,
): Promise<void> => {
  const inputResult = parseData(inputData, schema);
  if (!inputResult.success || !inputResult.data) {
    throw new Error(`Error validating input data: ${inputResult.error}`);
  }

  const mappedData = inputResult.data.map(mapToPrismaDataCallBack);
  if (mappedData.length === 0) {
    console.log('No data to insert. Skipping truncate_insert operation.');
    return;
  }

  try {
    await truncateData();
    await insertData(mappedData);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errorLogger({ message: `Error in truncate_insert: ${errorMessage}` });
    throw new Error(`Error in truncate_insert: ${errorMessage}`);
  }
};

/**
 * 1. validate the data using the zod schema
 * 2. map the data to the prisma schema
 * 3. preprocess data
 * 4. insert data when data does not exist
 * 5. update data when data exists
 */
const upsert = async <
  T extends z.ZodTypeAny,
  M extends Record<string, unknown>,
  K extends keyof M & string,
>(
  inputData: unknown,
  schema: T,
  mapToPrismaDataCallBack: (data: z.infer<T>) => M,
  mapToExistingDataCallBack: (data: z.infer<T>) => Prisma.JsonObject,
  uniqueKey: K,
  insertData: (data: M[]) => Promise<void>,
  updateData: (data: M[]) => Promise<void>,
): Promise<void> => {
  const inputResult = parseData(inputData, schema);
  if (!inputResult.success || !inputResult.data) {
    throw new Error(`Error validating input data: ${inputResult.error}`);
  }

  const mappedData = inputResult.data.map(mapToPrismaDataCallBack);
  if (mappedData.length === 0) {
    console.log('No data to insert. Skipping upsert operation.');
    return;
  }

  const existingData = mappedData.map(mapToExistingDataCallBack);
  const insertDataList: M[] = [];
  const updateDataList: M[] = [];

  const existingKeys = new Set(existingData.map((item) => String(item[uniqueKey])));

  mappedData.forEach((item) => {
    if (existingKeys.has(String(item[uniqueKey]))) {
      updateDataList.push(item);
    } else {
      insertDataList.push(item);
    }
  });

  try {
    if (insertDataList.length > 0) {
      await insertData(insertDataList);
      console.log(`Inserted ${insertDataList.length} new records.`);
    }

    if (updateDataList.length > 0) {
      await updateData(updateDataList);
      console.log(`Updated ${updateDataList.length} existing records.`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errorLogger({ message: `Error in upsert operation: ${errorMessage}` });
    throw new Error(`Error in upsert operation: ${errorMessage}`);
  }
};

/**
 * 1. validate the data using the zod schema
 * 2. map the data to the prisma schema
 * 3. preprocess data
 * 4. insert data
 */
const insert = async <T extends z.ZodTypeAny, M extends object>(
  inputData: unknown,
  schema: T,
  mapToPrismaDataCallBack: (data: z.infer<T>) => M,
  insertData: (data: M[]) => Promise<void>,
): Promise<void> => {
  const inputResult = parseData(inputData, schema);
  if (!inputResult.success || !inputResult.data) {
    throw new Error(`Error validating input data: ${inputResult.error}`);
  }

  const mappedData = inputResult.data.map(mapToPrismaDataCallBack);

  try {
    await insertData(mappedData);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errorLogger({ message: `Error in insert: ${errorMessage}` });
    throw new Error(`Error in insert: ${errorMessage}`);
  }
};

export { insert, safeCreateMany, safeDelete, safeUpdateMany, truncate_insert, upsert };
