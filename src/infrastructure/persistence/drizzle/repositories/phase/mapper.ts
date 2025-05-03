import { PhaseCreateInput, DbPhase, DbPhaseCreateInput } from 'repository/phase/types';
import { Phase, PhaseId } from 'types/domain/phase.type';

export const mapDbPhaseToDomain = (dbPhase: DbPhase): Phase => ({
  id: dbPhase.id as PhaseId,
  name: dbPhase.name,
  startEvent: dbPhase.startEvent,
  stopEvent: dbPhase.stopEvent,
  highestScore: dbPhase.highestScore ?? null,
});

export const mapDomainPhaseToDbCreate = (domainPhase: PhaseCreateInput): DbPhaseCreateInput => ({
  id: Number(domainPhase.id),
  name: domainPhase.name,
  startEvent: domainPhase.startEvent,
  stopEvent: domainPhase.stopEvent,
  highestScore: domainPhase.highestScore,
});
