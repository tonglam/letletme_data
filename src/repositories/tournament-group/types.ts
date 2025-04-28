import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/tournament-group';
import { TournamentGroup, TournamentGroups } from 'types/domain/tournament-group.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { DBError } from 'types/error.type';

export type DbTournamentGroup = InferSelectModel<typeof schema.tournamentGroups>;
export type DbTournamentGroupCreateInput = InferInsertModel<typeof schema.tournamentGroups>;

export type TournamentGroupCreateInput = TournamentGroup;
export type TournamentGroupCreateInputs = readonly TournamentGroupCreateInput[];

export interface TournamentGroupRepository {
  readonly findByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<DBError, TournamentGroups>;
  readonly saveBatchByTournamentId: (
    tournamentGroups: TournamentGroupCreateInputs,
  ) => TE.TaskEither<DBError, TournamentGroups>;
}
