import { FPLEndpoints } from '../../infrastructure/http/fpl/types';
import { EventResponse } from '../../types/events.type';
import { BootstrapApi } from './operations';

export const createBootstrapApiAdapter = (
  client: FPLEndpoints,
): BootstrapApi & { getBootstrapEvents: () => Promise<EventResponse[]> } => ({
  getBootstrapData: async () => {
    const result = await client.bootstrap.getBootstrapStatic();
    if (result._tag === 'Left') {
      throw result.left;
    }
    return result.right;
  },
  getBootstrapEvents: async () => {
    const result = await client.bootstrap.getBootstrapStatic();
    if (result._tag === 'Left') {
      throw result.left;
    }
    return result.right.events;
  },
});
