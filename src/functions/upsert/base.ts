import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { errorLogger } from '../../utils/logger.util';

const BATCH_SIZE = 1000; // PostgreSQL parameter limit protection

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
  // Validate input data
  const inputResult = parseData(inputData, schema);
  if (!inputResult.success || !inputResult.data) {
    throw new Error(`Error validating input data: ${inputResult.error}`);
  }

  // Transform data
  const mappedData = inputResult.data.map(mapToPrismaDataCallBack);
  if (mappedData.length === 0) {
    console.log('No data to insert. Skipping truncate_insert operation.');
    return;
  }

  try {
    // Use transaction for atomicity
    await prisma.$transaction(
      async () => {
        // Truncate with CASCADE to handle foreign key constraints
        await truncateData();

        // Insert data in batches
        for (let i = 0; i < mappedData.length; i += BATCH_SIZE) {
          const batch = mappedData.slice(i, i + BATCH_SIZE);
          await insertData(batch);
          console.log(
            `Inserted batch ${i / BATCH_SIZE + 1} of ${Math.ceil(mappedData.length / BATCH_SIZE)}`,
          );
        }
      },
      {
        timeout: 30000, // 30 second timeout
        maxWait: 5000, // 5 second max wait for transaction
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable, // Highest isolation level
      },
    );

    console.log(`Successfully inserted ${mappedData.length} records`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errorLogger({
      message: `Error in truncate_insert: ${errorMessage}. Data length: ${mappedData.length}, First item: ${JSON.stringify(mappedData[0])}, Stack: ${error instanceof Error ? error.stack : 'No stack trace'}`,
    });
    throw new Error(`Error in truncate_insert: ${errorMessage}`);
  }
};

/**
 * Generic upsert function that handles data validation, transformation, and database operations
 * 1. Validates input data using Zod schema
 * 2. Maps data to Prisma schema
 * 3. Fetches existing data
 * 4. Performs insert for new data and update for existing data
 */
const upsert = async <T extends z.ZodTypeAny, M extends Record<string, unknown>, K extends keyof M>(
  inputData: unknown,
  schema: T,
  mapToPrismaDataCallBack: (data: z.infer<T>) => M,
  getExistingData: () => Promise<Map<string | number, M>>,
  uniqueKey: K & (M[K] extends string | number ? K : never),
  insertData: (data: M[]) => Promise<void>,
  updateData: (data: M[]) => Promise<void>,
): Promise<void> => {
  // Validate input data
  const inputResult = parseData(inputData, schema);
  if (!inputResult.success || !inputResult.data) {
    throw new Error(`Error validating input data: ${inputResult.error}`);
  }

  try {
    // Transform data and get existing records
    const [mappedData, existingDataMap] = await Promise.all([
      Promise.resolve(inputResult.data.map(mapToPrismaDataCallBack)),
      getExistingData(),
    ]);

    if (mappedData.length === 0) {
      console.log('No data to upsert. Skipping operation.');
      return;
    }

    // Separate data into inserts and updates
    const [dataToInsert, dataToUpdate] = mappedData.reduce<[M[], M[]]>(
      (acc, item) => {
        const key = item[uniqueKey] as string | number;
        if (existingDataMap.has(key)) {
          acc[1].push(item);
        } else {
          acc[0].push(item);
        }
        return acc;
      },
      [[], []],
    );

    // Use transaction for atomicity
    await prisma.$transaction(
      async () => {
        // Handle inserts in batches
        if (dataToInsert.length > 0) {
          for (let i = 0; i < dataToInsert.length; i += BATCH_SIZE) {
            const batch = dataToInsert.slice(i, i + BATCH_SIZE);
            await insertData(batch);
            console.log(
              `Inserted batch ${i / BATCH_SIZE + 1} of ${Math.ceil(dataToInsert.length / BATCH_SIZE)}`,
            );
          }
        }

        // Handle updates in batches
        if (dataToUpdate.length > 0) {
          for (let i = 0; i < dataToUpdate.length; i += BATCH_SIZE) {
            const batch = dataToUpdate.slice(i, i + BATCH_SIZE);
            await updateData(batch);
            console.log(
              `Updated batch ${i / BATCH_SIZE + 1} of ${Math.ceil(dataToUpdate.length / BATCH_SIZE)}`,
            );
          }
        }
      },
      {
        timeout: 30000,
        maxWait: 5000,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    console.log(
      `Successfully processed ${mappedData.length} records (${dataToInsert.length} inserts, ${dataToUpdate.length} updates)`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errorLogger({
      message: `Error in upsert: ${errorMessage}. Stack: ${error instanceof Error ? error.stack : 'No stack trace'}`,
    });
    throw new Error(`Error in upsert: ${errorMessage}`);
  }
};

/**
 * Generic insert function that handles data validation, transformation, and database operations
 * 1. Validates input data using Zod schema
 * 2. Maps data to Prisma schema
 * 3. Performs batch inserts for better performance
 */
const insert = async <T extends z.ZodTypeAny, M extends Record<string, unknown>>(
  inputData: unknown,
  schema: T,
  mapToPrismaDataCallBack: (data: z.infer<T>) => M,
  truncateData: () => Promise<void>,
  insertData: (data: M[]) => Promise<void>,
): Promise<void> => {
  // Validate input data
  const inputResult = parseData(inputData, schema);
  if (!inputResult.success || !inputResult.data) {
    throw new Error(`Error validating input data: ${inputResult.error}`);
  }

  try {
    // Transform data
    const mappedData = inputResult.data.map(mapToPrismaDataCallBack);

    if (mappedData.length === 0) {
      console.log('No data to insert. Skipping operation.');
      return;
    }

    // Use transaction for atomicity
    await prisma.$transaction(
      async () => {
        // Truncate existing data
        await truncateData();

        // Handle inserts in batches
        for (let i = 0; i < mappedData.length; i += BATCH_SIZE) {
          const batch = mappedData.slice(i, i + BATCH_SIZE);
          await insertData(batch);
          console.log(
            `Inserted batch ${i / BATCH_SIZE + 1} of ${Math.ceil(mappedData.length / BATCH_SIZE)}`,
          );
        }
      },
      {
        timeout: 30000, // 30 second timeout
        maxWait: 5000, // 5 second max wait for transaction
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable, // Highest isolation level
      },
    );

    console.log(`Successfully inserted ${mappedData.length} records`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errorLogger({
      message: `Error in insert: ${errorMessage}. Stack: ${error instanceof Error ? error.stack : 'No stack trace'}`,
    });
    throw new Error(`Error in insert: ${errorMessage}`);
  }
};

export { insert, truncate_insert, upsert };
