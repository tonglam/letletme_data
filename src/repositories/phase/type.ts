import { Prisma, Phase as PrismaPhaseType } from '@prisma/client';
import { Phase, PhaseId } from '../../types/domain/phase.type';

export type PrismaPhaseCreateInput = Prisma.PhaseCreateInput;
export type PrismaPhase = PrismaPhaseType;

export type PrismaPhaseCreate = Omit<Phase, 'id'> & { id: PhaseId };
