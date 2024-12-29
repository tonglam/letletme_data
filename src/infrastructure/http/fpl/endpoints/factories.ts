import { HTTPClient } from '../../client';
import { FPLEndpoints } from '../types';
import { createBootstrapEndpoints } from './bootstrap';
import { createElementEndpoints } from './element';
import { createEntryEndpoints } from './entry';
import { createEventEndpoints } from './event';
import { createLeaguesEndpoints } from './leagues';

export const createFPLEndpoints = (client: HTTPClient): FPLEndpoints => ({
  bootstrap: createBootstrapEndpoints(client),
  element: createElementEndpoints(client),
  entry: createEntryEndpoints(client),
  event: createEventEndpoints(client),
  leagues: createLeaguesEndpoints(client),
});
