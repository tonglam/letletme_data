import { z } from 'zod';

export const TransferResponseSchema = z
  .object({
    entry: z.number(),
    event: z.number(),
    element_in: z.number(),
    element_in_cost: z.number(),
    element_out: z.number(),
    element_out_cost: z.number(),
    time: z.string().nullable(),
  })
  .passthrough();

export type TransferResponse = z.infer<typeof TransferResponseSchema>;
export type TransfersResponse = readonly TransferResponse[];
