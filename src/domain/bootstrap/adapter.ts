import * as E from 'fp-ts/Either';
import { FPLEndpoints } from '../../infrastructure/http/fpl/types';
import { BootStrapResponse } from '../../types/bootstrap.type';
import { APIError } from '../../types/errors.type';
import { EventResponse } from '../../types/events.type';
import { BootstrapApi } from './operations';

// Minimal type for raw API response
interface RawBootstrapResponse {
  events?: unknown[];
  phases?: unknown[];
  teams?: unknown[];
  elements?: unknown[];
}

export interface ExtendedBootstrapApi extends BootstrapApi {
  getBootstrapEvents: () => Promise<EventResponse[]>;
  getBootstrapPhases: () => Promise<BootStrapResponse['phases']>;
  getBootstrapTeams: () => Promise<BootStrapResponse['teams']>;
  getBootstrapElements: () => Promise<BootStrapResponse['elements']>;
}

export const createBootstrapApiAdapter = (client: FPLEndpoints): ExtendedBootstrapApi => {
  // Cache the bootstrap data promise to avoid multiple API calls
  let bootstrapDataPromise: Promise<unknown> | null = null;

  const getBootstrapData = async (): Promise<BootStrapResponse> => {
    if (!bootstrapDataPromise) {
      bootstrapDataPromise = client.bootstrap.getBootstrapStatic().then(
        E.fold(
          (error: APIError) => {
            bootstrapDataPromise = null; // Reset cache on error
            throw error;
          },
          // Accept flexible API response, we'll validate fields when transforming to domain models
          (data: RawBootstrapResponse) => ({
            events: data.events || [],
            phases: data.phases || [],
            teams: data.teams || [],
            elements: data.elements || [],
          }),
        ),
      );
    }
    return bootstrapDataPromise as Promise<BootStrapResponse>;
  };

  return {
    getBootstrapData,
    getBootstrapEvents: async () => {
      const data = await getBootstrapData();
      return data.events;
    },
    getBootstrapPhases: async () => {
      const data = await getBootstrapData();
      return data.phases;
    },
    getBootstrapTeams: async () => {
      const data = await getBootstrapData();
      return data.teams;
    },
    getBootstrapElements: async () => {
      const data = await getBootstrapData();
      return data.elements;
    },
  };
};
