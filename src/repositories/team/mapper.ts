import { PrismaTeam, PrismaTeamCreateInput, TeamCreateInput } from 'src/repositories/team/type';

import { Team, TeamId } from '../../types/domain/team.type';

export const mapPrismaTeamToDomain = (prismaTeam: PrismaTeam): Team => ({
  id: prismaTeam.id as TeamId,
  code: prismaTeam.code,
  name: prismaTeam.name,
  shortName: prismaTeam.shortName,
  strength: prismaTeam.strength,
  position: prismaTeam.position,
  points: prismaTeam.points,
  win: prismaTeam.win,
  draw: prismaTeam.draw,
  loss: prismaTeam.loss,
});

export const mapDomainTeamToPrismaCreate = (
  domainTeam: TeamCreateInput,
): PrismaTeamCreateInput => ({
  id: Number(domainTeam.id),
  code: domainTeam.code,
  name: domainTeam.name,
  shortName: domainTeam.shortName,
  strength: domainTeam.strength,
  position: domainTeam.position,
  points: domainTeam.points,
  win: domainTeam.win,
  draw: domainTeam.draw,
  loss: domainTeam.loss,
});
