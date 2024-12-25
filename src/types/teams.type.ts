import { PrismaClient } from '@prisma/client';
import { Either, left, right } from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { z } from 'zod';
import { createError } from '../domains/phases/operations';
import { APIError } from '../infrastructure/api/common/errors';
import { CacheError } from '../infrastructure/cache/types';

// ============ Branded Types ============
declare const TeamIdBrand: unique symbol;
export type TeamId = number & { readonly _brand: typeof TeamIdBrand };

// ============ Schemas ============
/**
 * API Response Schema - Validates external API data (snake_case)
 */
const TeamResponseSchema = z.object({
  id: z.number(),
  code: z.number(),
  name: z.string(),
  short_name: z.string(),
  strength: z.number(),
  strength_overall_home: z.number().optional(),
  strength_overall_away: z.number().optional(),
  strength_attack_home: z.number().optional(),
  strength_attack_away: z.number().optional(),
  strength_defence_home: z.number().optional(),
  strength_defence_away: z.number().optional(),
  pulse_id: z.number().optional(),
  played: z.number().optional(),
  position: z.number().optional(),
  points: z.number().optional(),
  form: z.string().nullable().optional(),
  win: z.number().optional(),
  draw: z.number().optional(),
  loss: z.number().optional(),
  team_division: z.string().nullable().optional(),
  unavailable: z.boolean().optional(),
});

/**
 * Domain Schema - Internal application model (camelCase)
 */
const TeamSchema = z.object({
  id: z.custom<TeamId>((val) => isTeamId(val), { message: 'Invalid TeamId' }),
  code: z.number(),
  name: z.string(),
  shortName: z.string(),
  strength: z.number(),
  strengthOverallHome: z.number().default(0),
  strengthOverallAway: z.number().default(0),
  strengthAttackHome: z.number().default(0),
  strengthAttackAway: z.number().default(0),
  strengthDefenceHome: z.number().default(0),
  strengthDefenceAway: z.number().default(0),
  pulseId: z.number().default(0),
  played: z.number().default(0),
  position: z.number().default(0),
  points: z.number().default(0),
  form: z.string().nullable().default(null),
  win: z.number().default(0),
  draw: z.number().default(0),
  loss: z.number().default(0),
  teamDivision: z.string().nullable().default(null),
  unavailable: z.boolean().default(false),
});

export const TeamsSchema = z.array(TeamSchema);
export const TeamsResponseSchema = z.array(TeamResponseSchema);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type TeamResponse = z.infer<typeof TeamResponseSchema>;
export type TeamsResponse = z.infer<typeof TeamsResponseSchema>;

// ============ Domain Types ============
export interface Team {
  readonly id: TeamId;
  readonly code: number;
  readonly name: string;
  readonly shortName: string;
  readonly strength: number;
  readonly strengthOverallHome: number;
  readonly strengthOverallAway: number;
  readonly strengthAttackHome: number;
  readonly strengthAttackAway: number;
  readonly strengthDefenceHome: number;
  readonly strengthDefenceAway: number;
  readonly pulseId: number;
  readonly played: number;
  readonly position: number;
  readonly points: number;
  readonly form: string | null;
  readonly win: number;
  readonly draw: number;
  readonly loss: number;
  readonly teamDivision: string | null;
  readonly unavailable: boolean;
}

export type Teams = readonly Team[];

// ============ Persistence Types ============
export interface PrismaTeam {
  readonly id: number;
  readonly code: number;
  readonly name: string;
  readonly shortName: string;
  readonly strength: number;
  readonly strengthOverallHome: number;
  readonly strengthOverallAway: number;
  readonly strengthAttackHome: number;
  readonly strengthAttackAway: number;
  readonly strengthDefenceHome: number;
  readonly strengthDefenceAway: number;
  readonly pulseId: number;
  readonly played: number;
  readonly position: number;
  readonly points: number;
  readonly form: string | null;
  readonly win: number;
  readonly draw: number;
  readonly loss: number;
  readonly teamDivision: string | null;
  readonly unavailable: boolean;
  readonly createdAt: Date;
}

export interface PrismaTeamCreate extends Omit<PrismaTeam, 'id' | 'createdAt'> {
  readonly id?: number;
  readonly createdAt: Date;
}

// ============ Type Guards & Validation ============
export const isTeamId = (id: unknown): id is TeamId =>
  typeof id === 'number' && id > 0 && Number.isInteger(id);

export const validateTeamId = (id: number): Either<string, TeamId> =>
  isTeamId(id) ? right(id as TeamId) : left(`Invalid team ID: ${id}`);

export const isValidTeam = (team: Team): boolean =>
  isTeamId(team.id) &&
  typeof team.code === 'number' &&
  typeof team.name === 'string' &&
  team.name.length > 0 &&
  typeof team.shortName === 'string' &&
  team.shortName.length > 0 &&
  typeof team.strength === 'number' &&
  typeof team.strengthOverallHome === 'number' &&
  typeof team.strengthOverallAway === 'number' &&
  typeof team.strengthAttackHome === 'number' &&
  typeof team.strengthAttackAway === 'number' &&
  typeof team.strengthDefenceHome === 'number' &&
  typeof team.strengthDefenceAway === 'number' &&
  typeof team.pulseId === 'number' &&
  typeof team.played === 'number' &&
  typeof team.position === 'number' &&
  typeof team.points === 'number' &&
  (team.form === null || typeof team.form === 'string') &&
  typeof team.win === 'number' &&
  typeof team.draw === 'number' &&
  typeof team.loss === 'number' &&
  (team.teamDivision === null || typeof team.teamDivision === 'string') &&
  typeof team.unavailable === 'boolean';

// ============ Repository Interface ============
export interface TeamRepository {
  prisma: PrismaClient;
  findById(id: TeamId): TE.TaskEither<APIError, PrismaTeam | null>;
  findAll(): TE.TaskEither<APIError, PrismaTeam[]>;
  save(data: PrismaTeamCreate): TE.TaskEither<APIError, PrismaTeam>;
  saveBatch(data: PrismaTeamCreate[]): TE.TaskEither<APIError, PrismaTeam[]>;
  update(id: TeamId, data: Partial<PrismaTeamCreate>): TE.TaskEither<APIError, PrismaTeam>;
  deleteAll(): TE.TaskEither<APIError, void>;
  findByIds(ids: TeamId[]): TE.TaskEither<APIError, PrismaTeam[]>;
  deleteByIds(ids: TeamId[]): TE.TaskEither<APIError, void>;
}

// ============ Type Transformers ============
/**
 * Transform PrismaTeam to TeamResponse
 */
export const prismaToResponse = (team: PrismaTeam): TeamResponse => ({
  id: team.id,
  code: team.code,
  name: team.name,
  short_name: team.shortName,
  strength: team.strength,
  strength_overall_home: team.strengthOverallHome,
  strength_overall_away: team.strengthOverallAway,
  strength_attack_home: team.strengthAttackHome,
  strength_attack_away: team.strengthAttackAway,
  strength_defence_home: team.strengthDefenceHome,
  strength_defence_away: team.strengthDefenceAway,
  pulse_id: team.pulseId,
  played: team.played,
  position: team.position,
  points: team.points,
  form: team.form,
  win: team.win,
  draw: team.draw,
  loss: team.loss,
  team_division: team.teamDivision,
  unavailable: team.unavailable,
});

/**
 * Transform and validate TeamResponse to Team
 */
export const toDomainTeam = (raw: TeamResponse): Either<string, Team> => {
  try {
    if (!isTeamId(raw.id)) {
      return left(`Invalid team ID: ${raw.id}`);
    }

    const team: Team = {
      id: raw.id as TeamId,
      code: raw.code,
      name: raw.name,
      shortName: raw.short_name,
      strength: raw.strength,
      strengthOverallHome: raw.strength_overall_home ?? 0,
      strengthOverallAway: raw.strength_overall_away ?? 0,
      strengthAttackHome: raw.strength_attack_home ?? 0,
      strengthAttackAway: raw.strength_attack_away ?? 0,
      strengthDefenceHome: raw.strength_defence_home ?? 0,
      strengthDefenceAway: raw.strength_defence_away ?? 0,
      pulseId: raw.pulse_id ?? 0,
      played: raw.played ?? 0,
      position: raw.position ?? 0,
      points: raw.points ?? 0,
      form: raw.form ?? null,
      win: raw.win ?? 0,
      draw: raw.draw ?? 0,
      loss: raw.loss ?? 0,
      teamDivision: raw.team_division ?? null,
      unavailable: raw.unavailable ?? false,
    };

    return right(team);
  } catch (error) {
    return left(
      `Failed to transform team data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Transform Team to PrismaTeam
 */
export const toPrismaTeam = (team: Team): PrismaTeam => ({
  id: team.id as number,
  code: team.code,
  name: team.name,
  shortName: team.shortName,
  strength: team.strength,
  strengthOverallHome: team.strengthOverallHome,
  strengthOverallAway: team.strengthOverallAway,
  strengthAttackHome: team.strengthAttackHome,
  strengthAttackAway: team.strengthAttackAway,
  strengthDefenceHome: team.strengthDefenceHome,
  strengthDefenceAway: team.strengthDefenceAway,
  pulseId: team.pulseId,
  played: team.played,
  position: team.position,
  points: team.points,
  form: team.form,
  win: team.win,
  draw: team.draw,
  loss: team.loss,
  teamDivision: team.teamDivision,
  unavailable: team.unavailable,
  createdAt: new Date(),
});

// ============ Type Converters ============
/**
 * Convert PrismaTeam array to Team array
 */
export const convertPrismaTeams = (
  teams: readonly PrismaTeam[],
): TE.TaskEither<APIError, readonly Team[]> =>
  pipe(
    teams,
    TE.traverseArray((team) =>
      pipe(
        prismaToResponse(team),
        toDomainTeam,
        TE.fromEither,
        TE.mapLeft((error: string) => createError('Failed to convert team', error)),
      ),
    ),
  );

/**
 * Convert single PrismaTeam to Team
 */
export const convertPrismaTeam = (team: PrismaTeam | null): TE.TaskEither<APIError, Team | null> =>
  team
    ? pipe(
        prismaToResponse(team),
        toDomainTeam,
        TE.fromEither,
        TE.mapLeft((error: string) => createError('Failed to convert team', error)),
      )
    : TE.right(null);

/**
 * Get cached teams or fallback to repository
 */
export const getCachedOrFallbackMany = (
  cachedValue: TE.TaskEither<CacheError, readonly PrismaTeam[]> | undefined,
  fallback: TE.TaskEither<APIError, readonly PrismaTeam[]>,
): TE.TaskEither<APIError, readonly Team[]> =>
  cachedValue
    ? pipe(
        cachedValue,
        TE.mapLeft((error) => createError('Cache operation failed', error)),
        TE.chain(convertPrismaTeams),
      )
    : pipe(fallback, TE.chain(convertPrismaTeams));

/**
 * Get cached team or fallback to repository
 */
export const getCachedOrFallbackOne = (
  cachedValue: TE.TaskEither<CacheError, PrismaTeam | null> | undefined,
  fallback: TE.TaskEither<APIError, PrismaTeam | null>,
): TE.TaskEither<APIError, Team | null> =>
  cachedValue
    ? pipe(
        cachedValue,
        TE.mapLeft((error) => createError('Cache operation failed', error)),
        TE.chain(convertPrismaTeam),
      )
    : pipe(fallback, TE.chain(convertPrismaTeam));
