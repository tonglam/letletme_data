import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/tournament-info.schema';
import { TournamentInfo, TournamentInfos, TournamentId } from 'types/domain/tournament-info.type';
import { DBError } from 'types/error.type';

export type DbTournamentInfo = InferSelectModel<typeof schema.tournamentInfos>;
export type DbTournamentInfoCreateInput = InferInsertModel<typeof schema.tournamentInfos>;

export type TournamentInfoCreateInput = TournamentInfo;
export type TournamentInfoCreateInputs = readonly TournamentInfoCreateInput[];

export interface TournamentInfoRepository {
  readonly findById: (id: TournamentId) => TE.TaskEither<DBError, TournamentInfo>;
  readonly findAll: () => TE.TaskEither<DBError, TournamentInfos>;
}
