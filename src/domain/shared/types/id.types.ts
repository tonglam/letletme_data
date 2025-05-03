import * as E from 'fp-ts/Either';
import { z, ZodError } from 'zod';

// Helper to format Zod errors
const formatZodError = (error: ZodError): Error => {
  const messages = error.errors.map((e) => e.message).join(', ');
  return new Error(messages);
};

// --- EventID ---
export const EventIDSchema = z
  .number()
  .int({ message: 'Event ID must be an integer' })
  .min(1, { message: 'Event ID must be between 1 and 38' })
  .max(38, { message: 'Event ID must be between 1 and 38' })
  .brand<'EventID'>();

export type EventID = z.infer<typeof EventIDSchema>;

export const validateEventId = (value: unknown): E.Either<Error, EventID> => {
  const result = EventIDSchema.safeParse(value);
  return result.success ? E.right(result.data) : E.left(formatZodError(result.error));
};

// --- PhaseID ---
export const PhaseIDSchema = z
  .number()
  .int({ message: 'Phase ID must be an integer' })
  .min(1, { message: 'Phase ID must be between 1 and 38' })
  .max(38, { message: 'Phase ID must be between 1 and 38' })
  .brand<'PhaseID'>();

export type PhaseID = z.infer<typeof PhaseIDSchema>;

export const validatePhaseId = (value: unknown): E.Either<Error, PhaseID> => {
  const result = PhaseIDSchema.safeParse(value);
  return result.success ? E.right(result.data) : E.left(formatZodError(result.error));
};

// --- PlayerID ---
export const PlayerIDSchema = z
  .number()
  .int({ message: 'Player ID must be an integer' })
  .positive({ message: 'Player ID must be positive' })
  .brand<'PlayerID'>();

export type PlayerID = z.infer<typeof PlayerIDSchema>;

export const validatePlayerId = (value: unknown): E.Either<Error, PlayerID> => {
  const result = PlayerIDSchema.safeParse(value);
  return result.success ? E.right(result.data) : E.left(formatZodError(result.error));
};

// --- TeamID ---
export const TeamIDSchema = z
  .number()
  .int({ message: 'Team ID must be an integer' })
  .min(1, { message: 'Team ID must be between 1 and 20' })
  .max(20, { message: 'Team ID must be between 1 and 20' })
  .brand<'TeamID'>();

export type TeamID = z.infer<typeof TeamIDSchema>;

export const validateTeamId = (value: unknown): E.Either<Error, TeamID> => {
  const result = TeamIDSchema.safeParse(value);
  return result.success ? E.right(result.data) : E.left(formatZodError(result.error));
};

// --- EntryID ---
export const EntryIDSchema = z
  .number()
  .int({ message: 'Entry ID must be an integer' })
  .positive({ message: 'Entry ID must be positive' })
  .brand<'EntryID'>();

export type EntryID = z.infer<typeof EntryIDSchema>;

export const validateEntryId = (value: unknown): E.Either<Error, EntryID> => {
  const result = EntryIDSchema.safeParse(value);
  return result.success ? E.right(result.data) : E.left(formatZodError(result.error));
};

// --- TournamentID ---
export const TournamentIDSchema = z
  .number()
  .int({ message: 'Tournament ID must be an integer' })
  .positive({ message: 'Tournament ID must be positive' })
  .brand<'TournamentID'>();

export type TournamentID = z.infer<typeof TournamentIDSchema>;

export const validateTournamentId = (value: unknown): E.Either<Error, TournamentID> => {
  const result = TournamentIDSchema.safeParse(value);
  return result.success ? E.right(result.data) : E.left(formatZodError(result.error));
};

// --- TournamentGroupId ---
export const TournamentGroupIdSchema = z
  .number()
  .int({ message: 'Tournament Group ID must be an integer' })
  .positive({ message: 'Tournament Group ID must be positive' })
  .brand<'TournamentGroupId'>();

export type TournamentGroupId = z.infer<typeof TournamentGroupIdSchema>;

export const validateTournamentGroupId = (value: unknown): E.Either<Error, TournamentGroupId> => {
  const result = TournamentGroupIdSchema.safeParse(value);
  return result.success ? E.right(result.data) : E.left(formatZodError(result.error));
};

// --- LeagueID ---
export const LeagueIDSchema = z
  .number()
  .int({ message: 'League ID must be an integer' })
  .positive({ message: 'League ID must be positive' })
  .brand<'LeagueID'>();

export type LeagueID = z.infer<typeof LeagueIDSchema>;

export const validateLeagueId = (value: unknown): E.Either<Error, LeagueID> => {
  const result = LeagueIDSchema.safeParse(value);
  return result.success ? E.right(result.data) : E.left(formatZodError(result.error));
};
