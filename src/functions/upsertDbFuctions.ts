import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { errorLogger } from '../utils/logger.util';

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

export const truncate_insert = async <T extends z.ZodTypeAny, M extends object>(
  inputData: unknown,
  schema: z.ZodSchema<T>,
  mapToPrismaDataCallBack: (data: z.infer<T>) => Prisma.Exact<T, M>,
  modelType: M,
): Promise<void> => {
  const inputResult: z.infer<T> = await parseData(inputData, schema);

  const prismaData = mapToPrismaData(inputResult.data, modelType, mapToPrismaDataCallBack);
};

function parseData<T extends z.ZodTypeAny>(inputData: unknown, schema: T): Promise<z.infer<T>> {
  return schema.parse(inputData) as z.infer<T>;
}

function mapToPrismaData<T extends z.ZodTypeAny, M extends object>(
  data: z.infer<T>,
  modelType: M,
  mappingCallback: (data: z.infer<T>) => Prisma.Exact<T, M>,
): Prisma.Exact<T, M> {
  const mappedData = mappingCallback(data);
  return mappedData as Prisma.Exact<T, M>;
}
