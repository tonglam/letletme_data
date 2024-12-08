import { z } from 'zod';

/**
 * Validates data against a Zod schema
 */
export const validateData = async <T, S>(
  data: ReadonlyArray<T>,
  schema: z.ZodType<S>,
): Promise<ReadonlyArray<S>> => {
  const validatedData = await Promise.all(
    data.map(async (item) => {
      try {
        return await schema.parseAsync(item);
      } catch (error) {
        console.error('Validation error:', error);
        throw error;
      }
    }),
  );
  return validatedData;
};
