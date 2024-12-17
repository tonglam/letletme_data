import { z } from 'zod';

// ============ Types ============
/**
 * Generic type for Prisma model properties
 * Used internally for Prisma data mapping
 */
interface PrismaModelProperties {
  [key: string]: unknown;
}

/**
 * Generic type for mapping Zod validated data to Prisma schema
 * Used in base.ts for database operations
 */
export interface MapToPrismaData<T extends z.ZodTypeAny> {
  (data: z.infer<T>): PrismaModelProperties;
}
