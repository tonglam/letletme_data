import { PlayerStat, Prisma, PlayerStat as PrismaPlayerStatType } from '@prisma/client';

export type PrismaPlayerStatCreateInput = Omit<Prisma.PlayerStatCreateInput, 'id'>;
export type PrismaPlayerStat = PrismaPlayerStatType;

export type PrismaPlayerStatCreate = Omit<PlayerStat, 'id' | 'createdAt' | 'updatedAt'>;
