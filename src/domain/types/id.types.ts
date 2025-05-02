import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

// --- EventID ---
export type EventID = number & { readonly __brand: 'EventID' };

export const validateEventId = (value: unknown): E.Either<Error, EventID> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && v < 39 && Number.isInteger(v),
      (err) =>
        new Error(
          `Invalid event ID: must be a positive integer between 1 and 38. Received: ${err}`,
        ),
    ),
    E.map((v) => v as EventID),
  );

// --- PhaseID ---
export type PhaseID = number & { readonly __brand: 'PhaseID' };

export const validatePhaseId = (value: unknown): E.Either<Error, PhaseID> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && v < 39 && Number.isInteger(v),
      (err) =>
        new Error(
          `Invalid phase ID: must be a positive integer between 1 and 38. Received: ${err}`,
        ),
    ),
    E.map((v) => v as PhaseID),
  );

// --- PlayerID ---
export type PlayerID = number & { readonly __brand: 'PlayerID' };
export const validatePlayerId = (value: unknown): E.Either<Error, PlayerID> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      (err) => new Error(`Invalid player ID: must be a positive integer. Received: ${err}`),
    ),
    E.map((v) => v as PlayerID),
  );

// --- TeamID ---
export type TeamID = number & { readonly __brand: 'TeamID' };

export const validateTeamId = (value: unknown): E.Either<Error, TeamID> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && v < 21 && Number.isInteger(v),
      (err) =>
        new Error(`Invalid team ID: must be a positive integer between 1 and 20. Received: ${err}`),
    ),
    E.map((v) => v as TeamID),
  );

// --- EntryID ---
export type EntryID = number & { readonly __brand: 'EntryID' };

export const validateEntryId = (value: unknown): E.Either<Error, EntryID> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      (err) => new Error(`Invalid entry ID: must be a positive integer. Received: ${err}`),
    ),
    E.map((v) => v as EntryID),
  );

// --- TournamentID ---
export type TournamentID = number & { readonly __brand: 'TournamentID' };

export const validateTournamentId = (value: unknown): E.Either<Error, TournamentID> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      (err) => new Error(`Invalid tournament ID: must be a positive integer. Received: ${err}`),
    ),
    E.map((v) => v as TournamentID),
  );

// --- TournamentGroupId ---
export type TournamentGroupId = number & { readonly __brand: 'TournamentGroupId' };

export const validateTournamentGroupId = (value: unknown): E.Either<Error, TournamentGroupId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      (err) =>
        new Error(`Invalid tournament group ID: must be a positive integer. Received: ${err}`),
    ),
    E.map((v) => v as TournamentGroupId),
  );

// --- LeagueID ---
export type LeagueID = number & { readonly __brand: 'LeagueID' };

export const validateLeagueId = (value: unknown): E.Either<Error, LeagueID> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      (err) => new Error(`Invalid league ID: must be a positive integer. Received: ${err}`),
    ),
    E.map((v) => v as LeagueID),
  );
