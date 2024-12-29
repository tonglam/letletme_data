import { getCurrentSeason } from '../../types/domain/base.type';

/**
 * Application-wide configuration
 * @const {Readonly<{currentSeason: number}>}
 */
export const AppConfig = {
  currentSeason: getCurrentSeason(),
} as const;
