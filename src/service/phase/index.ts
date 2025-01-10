/**
 * Phase Service Module
 * Exports the phase service interface and implementation.
 */

import * as TE from 'fp-ts/TaskEither';
import { ServiceKey } from '../index';
import { registry, ServiceFactory } from '../registry';
import { createPhaseService } from './service';
import { PhaseService } from './types';

export const phaseServiceFactory: ServiceFactory<PhaseService> = {
  create: ({ bootstrapApi, phaseRepository }) =>
    TE.right(createPhaseService(bootstrapApi, phaseRepository)),
  dependencies: ['bootstrapApi', 'phaseRepository'],
};

registry.register(ServiceKey.PHASE, phaseServiceFactory);

export * from './service';
export * from './types';
