import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import {
  Branded,
  createBrandedType,
  GroupMode,
  KnockoutMode,
  LeagueType,
  TournamentMode,
  TournamentState,
} from 'src/types/base.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { LeagueId } from 'src/types/domain/league.type';

export type TournamentId = Branded<number, 'TournamentId'>;

export const createTournamentId = createBrandedType<number, 'TournamentId'>(
  'TournamentId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateTournamentId = (value: unknown): E.Either<string, TournamentId> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid tournament ID: must be a positive integer',
    ),
    E.map((v) => v as TournamentId),
  );
};

export type TournamentInfo = {
  readonly id: TournamentId;
  readonly name: string;
  readonly creator: string;
  readonly adminEntryId: EntryId;
  readonly leagueId: LeagueId;
  readonly leagueType: LeagueType;
  readonly totalTeamNum: number;
  readonly tournamentMode: TournamentMode;
  readonly groupMode: GroupMode;
  readonly groupTeamNum: number | null;
  readonly groupNum: number | null;
  readonly groupStartedEventId: EventId | null;
  readonly groupEndedEventId: EventId | null;
  readonly groupAutoAverages: boolean | null;
  readonly groupRounds: number | null;
  readonly groupPlayAgainstNum: number | null;
  readonly groupQualifyNum: number | null;
  readonly knockoutMode: KnockoutMode;
  readonly knockoutTeamNum: number | null;
  readonly knockoutRounds: number | null;
  readonly knockoutEventNum: number | null;
  readonly knockoutStartedEventId: EventId | null;
  readonly knockoutEndedEventId: EventId | null;
  readonly knockoutPlayAgainstNum: number | null;
  readonly state: TournamentState;
};

export type TournamentInfos = readonly TournamentInfo[];
