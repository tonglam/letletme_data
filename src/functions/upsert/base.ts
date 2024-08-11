import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { errorLogger } from '../../utils/logger.util';

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
  mapToExistingDataCallBack: () => Promise<Prisma.JsonObject>,
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

  const insertDataList: M[] = [];
  const updateDataList: M[] = [];

  const existingData = await mapToExistingDataCallBack();
  const existingKeys = new Set(Object.keys(existingData));

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

export { insert, truncate_insert, upsert };
