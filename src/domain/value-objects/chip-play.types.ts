import { Chip } from '@app/domain/types/chip.types';

export type ChipPlay = {
  readonly chip_name: Chip;
  readonly num_played: number;
};

export type ChipPlays = readonly ChipPlay[];
