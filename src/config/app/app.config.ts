import { getCurrentSeason } from '../../types/base.type';

// Application-wide configuration
export const AppConfig = {
  currentSeason: getCurrentSeason(),
} as const;
