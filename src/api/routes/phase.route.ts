import { Router } from 'express';
import * as t from 'io-ts';
import { ServiceContainer } from 'services/types';
import { createPhaseHandlers } from '../handlers/phase.handler';
import { createHandler, validateRequest } from '../middlewares/core';

const PhaseIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

export const phaseRouter = ({ phaseService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createPhaseHandlers(phaseService);

  router.get('/', createHandler(handlers.getAllPhases));
  router.get('/:id', validateRequest(PhaseIdParams), createHandler(handlers.getPhaseById));

  return router;
};
