import { getCurrentSeason } from '../../types/base.type';

export const AppConfig = {
  currentSeason: getCurrentSeason(),
} as const;
