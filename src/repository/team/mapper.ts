import { TeamCreateInput, DbTeam, DbTeamCreateInput } from 'repository/team/types';
import { Team, TeamId } from 'types/domain/team.type';

export const mapDbTeamToDomain = (dbTeam: DbTeam): Team => ({
  id: dbTeam.id as TeamId,
  code: dbTeam.code,
  name: dbTeam.name,
  shortName: dbTeam.shortName,
  strength: dbTeam.strength,
  position: dbTeam.position,
  points: dbTeam.points,
  win: dbTeam.win,
  draw: dbTeam.draw,
  loss: dbTeam.loss,
});

export const mapDomainTeamToDbCreate = (domainTeam: TeamCreateInput): DbTeamCreateInput => ({
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
