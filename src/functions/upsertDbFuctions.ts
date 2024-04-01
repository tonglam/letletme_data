// import { SafeParseReturnType, ZodTypeAny } from 'zod';
// import { logger } from '../index';

// type ConvertFunction<T, U> = (data: T) => U;

// /**
//  * 1. validate the data using the zod schema
//  * 2. map the data to the prisma schema
//  * 3. delete all the existing data
//  * 4. insert the new data
//  */
// const truncate_insert = async <T, U>(
//   inputData: T,
//   ZodSchema: ZodTypeAny,
//   convertFunction: ConvertFunction<T, U>,
// ): Promise<void> => {
//   const inputResult = safeParse(inputData, ZodSchema);

//   if (!inputResult.success) {
//     logger.error(`Error validating input data: ${inputResult.error.message}`);
//     return;
//   }

//   const convertedData = convertFunction(inputResult);
// };

// const safeParse = <T, U>(inputData: T, ZodSchema: ZodTypeAny): SafeParseReturnType<T, U> => {
//   return ZodSchema.safeParse(inputData);
// };

// export { truncate_insert };
