import { PlayerStat, Prisma, PlayerStat as PrismaPlayerStatType } from '@prisma/client';
import { PlayerStatId } from 'src/types/domain/player-stat.type';

export type PrismaPlayerStatCreateInput = Prisma.PlayerStatCreateInput;
export type PrismaPlayerStat = PrismaPlayerStatType;

export type PrismaPlayerStatCreate = Omit<PlayerStat, 'id'> & { id: PlayerStatId };
