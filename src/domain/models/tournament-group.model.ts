import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { TournamentId } from 'types/domain/tournament-info.type';

export type TournamentGroupId = Branded<number, 'TournamentGroupId'>;

export const createTournamentGroupId = createBrandedType<number, 'TournamentGroupId'>(
  'TournamentGroupId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateTournamentGroupId = (value: unknown): E.Either<string, TournamentGroupId> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid tournament group ID: must be a positive integer',
    ),
    E.map((v) => v as TournamentGroupId),
  );
};

export type TournamentGroup = {
  readonly tournamentId: TournamentId;
  readonly groupId: TournamentGroupId;
  readonly groupName: string;
  readonly groupIndex: number;
  readonly entryId: EntryId;
  readonly startedEventId: EventId | null;
  readonly endedEventId: EventId | null;
  readonly groupPoints: number | null;
  readonly groupRank: number | null;
  readonly played: number | null;
  readonly won: number | null;
  readonly drawn: number | null;
  readonly lost: number | null;
  readonly totalPoints: number | null;
  readonly totalTransfersCost: number | null;
  readonly totalNetPoints: number | null;
  readonly qualified: number | null;
  readonly overallRank: number | null;
};

export type TournamentGroups = readonly TournamentGroup[];
