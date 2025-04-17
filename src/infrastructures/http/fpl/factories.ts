import { Logger } from 'pino';
import { HTTPClient } from '../client';
import { createBootstrapEndpoints } from './endpoints/bootstrap';
import { createElementEndpoints } from './endpoints/element';
import { createEntryEndpoints } from './endpoints/entry';
import { createEventEndpoints } from './endpoints/event';
import { createLeaguesEndpoints } from './endpoints/leagues';
import { FPLEndpoints } from './types';

export const createFPLEndpoints = (client: HTTPClient, logger: Logger): FPLEndpoints => ({
  bootstrap: createBootstrapEndpoints(client, logger),
  element: createElementEndpoints(client, logger),
  entry: createEntryEndpoints(client, logger),
  event: createEventEndpoints(client, logger),
  leagues: createLeaguesEndpoints(client, logger),
});
