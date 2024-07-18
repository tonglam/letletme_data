import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { errorLogger } from '../../utils/logger.util';

const handleZodError = (error: z.ZodError) => {
  const errorMessage = error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ');
  errorLogger({ message: `Error validating data: ${errorMessage}` });
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
  const inputResult: z.infer<T> = await parseData(inputData, schema);
  if (!inputResult.success || !inputResult.data) {
    handleZodError(inputResult.error);
    return;
  }

  const mappedData = inputResult.data.map(mapToPrismaDataCallBack);

  try {
    await truncateData();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      errorLogger({ message: `Error deleting data: ${error.message}` });
    }
  }

  try {
    await insertData(mappedData);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      errorLogger({ message: `Error inserting data: ${error.message}` });
    }
  }
};

function parseData<T extends z.ZodTypeAny>(
  inputData: unknown,
  schema: T,
): { success: boolean; data?: z.infer<T>[]; error?: z.ZodError } {
  try {
    const data = schema.array().parse(inputData);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error as z.ZodError };
  }
}

export { truncate_insert };
