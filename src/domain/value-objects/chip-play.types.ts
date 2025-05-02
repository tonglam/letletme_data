import { Chips } from '@app/domain/types/chip.types';
import { z } from 'zod';

export const ChipPlay = z.object({
  chip_name: z.enum(Chips),
  num_played: z.number().int().nonnegative(),
});

export type ChipPlay = z.infer<typeof ChipPlay>;
