import { PlayerValue, Prisma, PlayerValue as PrismaPlayerValueType } from '@prisma/client';

export type PrismaPlayerValueCreateInput = Omit<Prisma.PlayerValueCreateInput, 'id'>;
export type PrismaPlayerValue = PrismaPlayerValueType;

export type PrismaPlayerValueCreate = Omit<PlayerValue, 'id' | 'createdAt'>;
