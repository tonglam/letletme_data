import { z } from 'zod';

interface PrismaModelProperties {
  [key: string]: unknown;
}

// received a zod safe parsed data, return the prisma schema data
export interface MapToPrismaData<T extends z.ZodTypeAny> {
  (data: z.infer<T>): PrismaModelProperties;
}
