import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../index';

import { errorLogger, infoLogger } from '../../utils/logger.util';

interface ListCollectionsResult {
  cursor: {
    firstBatch: Array<{ name: string }>;
    id: number;
    ns: string;
  };
  ok: number;
}

type BatchUpdateOperation<T> = (batch: T[], prisma: PrismaClient) => Promise<number>;

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
    errorLogger({
      message: `Error checking if collection ${collectionName} exists: ${errorMessage}`,
    });
    throw error;
  }
};

const safeDelete = async (collectionName: string): Promise<void> => {
  try {
    const exists = await collectionExists(collectionName);
    if (!exists) {
      infoLogger({
        message: `Collection ${collectionName} does not exist. Skipping delete operation.`,
      });
      return;
    }

    await prisma.$runCommandRaw({
      delete: collectionName,
      deletes: [{ q: {}, limit: 0 }],
    });
    infoLogger({ message: `Successfully deleted all documents from ${collectionName}` });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errorLogger({ message: `Error while deleting ${collectionName} collection: ${errorMessage}` });
    throw error;
  }
};

async function batchUpdateMongoDB<T>(
  updateOps: Prisma.PrismaPromise<Prisma.BatchPayload>[],
  data: T[],
  batchSize: number = 10,
): Promise<void> {
  let updatedCount = 0;
  const totalItems = data.length;

  try {
    for (let i = 0; i < totalItems; i += batchSize) {
      const batch = updateOps.slice(i, i + batchSize);

      const results = await Promise.all(batch);
      const batchUpdateCount = results.reduce((sum, result) => sum + result.count, 0);
      updatedCount += batchUpdateCount;

      infoLogger({
        message: `Updated ${batchUpdateCount} records. Total updated: ${updatedCount}/${totalItems}`,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    infoLogger({ message: `Finished updating. Total records updated: ${updatedCount}` });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errorLogger({ message: `Error updating records: ${errorMessage}` });
    throw error;
  }
}

const getChangedFields = <T extends Record<string, unknown>>(
  existingData: T,
  newData: T,
  uniqueFields: (keyof T)[],
): Partial<T> => {
  const changedFields: Partial<T> = {};

  for (const [key, value] of Object.entries(newData) as [keyof T, T[keyof T]][]) {
    if (uniqueFields.includes(key)) {
      continue;
    }

    if (!isEqual(existingData[key], value)) {
      changedFields[key] = value;
    }
  }

  return changedFields;
};

function isEqual(value1: unknown, value2: unknown): boolean {
  if (value1 === value2) {
    return true;
  }
  if (typeof value1 !== typeof value2) {
    return false;
  }
  if (value1 === null || value2 === null) {
    return false;
  }
  if (value1 === undefined || value2 === undefined) {
    return false;
  }

  if (value1 instanceof Date && value2 instanceof Date) {
    return value1.getTime() === value2.getTime();
  }

  if (Array.isArray(value1) && Array.isArray(value2)) {
    if (value1.length !== value2.length) return false;
    for (let i = 0; i < value1.length; i++) {
      if (!isEqual(value1[i], value2[i])) return false;
    }
    return true;
  }

  if (typeof value1 === 'object' && typeof value2 === 'object') {
    const keys1 = Object.keys(value1 as object);
    const keys2 = Object.keys(value2 as object);
    if (keys1.length !== keys2.length) return false;
    for (const key of keys1) {
      if (
        !isEqual((value1 as Record<string, unknown>)[key], (value2 as Record<string, unknown>)[key])
      )
        return false;
    }
    return true;
  }

  return false;
}

export { batchUpdateMongoDB, BatchUpdateOperation, getChangedFields, safeDelete };
