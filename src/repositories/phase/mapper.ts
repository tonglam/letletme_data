import { PhaseCreateInput, PrismaPhase, PrismaPhaseCreateInput } from './types';
import { Phase, PhaseId } from '../../types/domain/phase.type';

export const mapPrismaPhaseToDomain = (prismaPhase: PrismaPhase): Phase => ({
  id: prismaPhase.id as PhaseId,
  name: prismaPhase.name,
  startEvent: prismaPhase.startEvent,
  stopEvent: prismaPhase.stopEvent,
  highestScore: prismaPhase.highestScore ?? null,
});

export const mapDomainPhaseToPrismaCreate = (
  domainPhase: PhaseCreateInput,
): PrismaPhaseCreateInput => ({
  id: Number(domainPhase.id),
  name: domainPhase.name,
  startEvent: domainPhase.startEvent,
  stopEvent: domainPhase.stopEvent,
  highestScore: domainPhase.highestScore,
});
