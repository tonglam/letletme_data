import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from './base.type';

// ============ Branded Types ============
export type TeamId = Branded<number, 'TeamId'>;

export const TeamId = createBrandedType<number, 'TeamId'>(
  'TeamId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

export const validateTeamId = (value: unknown): E.Either<string, TeamId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid team ID: must be a positive integer',
    ),
    E.map((v) => v as TeamId),
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
export type PrismaTeamUpdate = Omit<PrismaTeam, 'createdAt'>;

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

export const toPrismaTeam = (team: Team): PrismaTeamCreate => ({
  id: Number(team.id),
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
});
