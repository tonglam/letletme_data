import { Player, Prisma, Player as PrismaPlayerType } from '@prisma/client';
import { PlayerId } from 'src/types/domain/player.type';

export type PrismaPlayerCreateInput = Prisma.PlayerCreateInput;
export type PrismaPlayer = PrismaPlayerType;

export type PrismaPlayerCreate = Omit<Player, 'id'> & { id: PlayerId };
