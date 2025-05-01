import { pgEnum } from 'drizzle-orm/pg-core';

export const chipEnum = pgEnum('chip', ['n/a', 'wildcard', 'freehit', 'bboost', '3xc', 'manager']);

export const valueChangeTypeEnum = pgEnum('value_change_type', ['start', 'rise', 'fall']);

export const leagueTypeEnum = pgEnum('league_type', ['classic', 'h2h']);

export const cupResultEnum = pgEnum('cup_result', ['win', 'loss']);

export const tournamentModeEnum = pgEnum('tournament_mode', ['normal']);

export const groupModeEnum = pgEnum('group_mode', ['no_group', 'points_races', 'battle_races']);

export const knockoutModeEnum = pgEnum('knockout_mode', [
  'no_knockout',
  'single_elimination',
  'double_elimination',
  'head_to_head',
]);

export const tournamentStateEnum = pgEnum('tournament_state', ['active', 'inactive', 'finished']);
