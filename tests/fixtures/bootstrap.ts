import { Phase, PhaseId } from '../../src/types/phases.type';

export const getBootstrapData = async (): Promise<Phase[]> => [
  {
    id: 1 as PhaseId,
    name: 'Phase 1',
    startEvent: 1,
    stopEvent: 10,
    highestScore: null,
  },
  {
    id: 2 as PhaseId,
    name: 'Phase 2',
    startEvent: 11,
    stopEvent: 20,
    highestScore: null,
  },
];
