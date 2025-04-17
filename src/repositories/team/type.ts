import { Prisma, Team as PrismaTeamType } from '@prisma/client';
import { Team, TeamId } from '../../types/domain/team.type';

export type PrismaTeamCreateInput = Prisma.TeamCreateInput;
export type PrismaTeam = PrismaTeamType;

export type PrismaTeamCreate = Omit<Team, 'id'> & { id: TeamId };
