import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from './base.type';

// ============ Branded Types ============
export type TeamId = Branded<number, 'TeamId'>;

export const TeamId = createBrandedType<number, 'TeamId'>(
  'TeamId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export interface TeamResponse {
  readonly id: number;
  readonly code: number;
  readonly name: string;
  readonly short_name: string;
  readonly strength: number;
  readonly strength_overall_home: number;
  readonly strength_overall_away: number;
  readonly strength_attack_home: number;
  readonly strength_attack_away: number;
  readonly strength_defence_home: number;
  readonly strength_defence_away: number;
  readonly pulse_id: number;
  readonly played: number;
  readonly position: number;
  readonly points: number;
  readonly form: string | null;
  readonly win: number;
  readonly draw: number;
  readonly loss: number;
  readonly team_division: string | null;
  readonly unavailable: boolean;
}

export type TeamsResponse = readonly TeamResponse[];

/**
 * Domain types (camelCase)
 */
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

// ============ Repository Interface ============
export type TeamRepository = BaseRepository<PrismaTeam, PrismaTeamCreate, TeamId>;

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

export type PrismaTeamCreate = Omit<PrismaTeam, 'createdAt'>;

// ============ Converters ============
export const toDomainTeam = (data: TeamResponse | PrismaTeam): Team => {
  const isTeamApiResponse = (d: TeamResponse | PrismaTeam): d is TeamResponse =>
    isApiResponse(d, 'short_name');

  return {
    id: data.id as TeamId,
    code: data.code,
    name: data.name,
    shortName: isTeamApiResponse(data) ? data.short_name : data.shortName,
    strength: data.strength,
    strengthOverallHome: isTeamApiResponse(data)
      ? data.strength_overall_home
      : data.strengthOverallHome,
    strengthOverallAway: isTeamApiResponse(data)
      ? data.strength_overall_away
      : data.strengthOverallAway,
    strengthAttackHome: isTeamApiResponse(data)
      ? data.strength_attack_home
      : data.strengthAttackHome,
    strengthAttackAway: isTeamApiResponse(data)
      ? data.strength_attack_away
      : data.strengthAttackAway,
    strengthDefenceHome: isTeamApiResponse(data)
      ? data.strength_defence_home
      : data.strengthDefenceHome,
    strengthDefenceAway: isTeamApiResponse(data)
      ? data.strength_defence_away
      : data.strengthDefenceAway,
    pulseId: isTeamApiResponse(data) ? data.pulse_id : data.pulseId,
    played: data.played,
    position: data.position,
    points: data.points,
    form: data.form,
    win: data.win,
    draw: data.draw,
    loss: data.loss,
    teamDivision: isTeamApiResponse(data) ? data.team_division : data.teamDivision,
    unavailable: data.unavailable,
  };
};

export const convertPrismaTeams = (teams: readonly PrismaTeam[]): TE.TaskEither<string, Teams> =>
  pipe(
    teams,
    TE.right,
    TE.map((values) => values.map(toDomainTeam)),
  );

export const convertPrismaTeam = (team: PrismaTeam | null): TE.TaskEither<string, Team | null> =>
  TE.right(team ? toDomainTeam(team) : null);
