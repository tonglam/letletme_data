import { PlayerValue, Prisma, PlayerValue as PrismaPlayerValueType } from '@prisma/client';
import { PlayerValueId } from 'src/types/domain/player-value.type';

export type PrismaPlayerValueCreateInput = Prisma.PlayerValueCreateInput;
export type PrismaPlayerValue = PrismaPlayerValueType;

export type PrismaPlayerValueCreate = Omit<PlayerValue, 'id'> & { id: PlayerValueId };
