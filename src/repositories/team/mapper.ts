import { PrismaTeam, PrismaTeamCreate, PrismaTeamCreateInput } from 'src/repositories/team/type';

import { Team, TeamId } from '../../types/domain/team.type';

export const mapPrismaTeamToDomain = (prismaTeam: PrismaTeam): Team => ({
  id: prismaTeam.id as TeamId,
  code: prismaTeam.code,
  name: prismaTeam.name,
  shortName: prismaTeam.shortName,
  strength: prismaTeam.strength,
  strengthOverallHome: prismaTeam.strengthOverallHome,
  strengthOverallAway: prismaTeam.strengthOverallAway,
  strengthAttackHome: prismaTeam.strengthAttackHome,
  strengthAttackAway: prismaTeam.strengthAttackAway,
  strengthDefenceHome: prismaTeam.strengthDefenceHome,
  strengthDefenceAway: prismaTeam.strengthDefenceAway,
  pulseId: prismaTeam.pulseId,
  played: prismaTeam.played,
  position: prismaTeam.position,
  points: prismaTeam.points,
  form: prismaTeam.form,
  win: prismaTeam.win,
  draw: prismaTeam.draw,
  loss: prismaTeam.loss,
  teamDivision: prismaTeam.teamDivision,
  unavailable: prismaTeam.unavailable,
});

export const mapDomainTeamToPrismaCreate = (
  domainTeam: PrismaTeamCreate,
): PrismaTeamCreateInput => ({
  id: Number(domainTeam.id),
  code: domainTeam.code,
  name: domainTeam.name,
  shortName: domainTeam.shortName,
  strength: domainTeam.strength,
  strengthOverallHome: domainTeam.strengthOverallHome,
  strengthOverallAway: domainTeam.strengthOverallAway,
  strengthAttackHome: domainTeam.strengthAttackHome,
  strengthAttackAway: domainTeam.strengthAttackAway,
  strengthDefenceHome: domainTeam.strengthDefenceHome,
  strengthDefenceAway: domainTeam.strengthDefenceAway,
  pulseId: domainTeam.pulseId,
  played: domainTeam.played,
  position: domainTeam.position,
  points: domainTeam.points,
  form: domainTeam.form,
  win: domainTeam.win,
  draw: domainTeam.draw,
  loss: domainTeam.loss,
  teamDivision: domainTeam.teamDivision,
  unavailable: domainTeam.unavailable,
});
