import * as E from 'fp-ts/Either';
import { ElementResponse } from 'src/types/elements.type';
import { TeamResponse } from 'src/types/teams.type';
import { FPLEndpoints } from '../../infrastructure/http/fpl/types';
import { BootStrapResponse } from '../../types/bootstrap.type';
import { APIError } from '../../types/errors.type';
import { EventResponse } from '../../types/events.type';
import { PhaseResponse } from '../../types/phases.type';
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

  const getBootstrapEvents = async (): Promise<EventResponse[]> => {
    try {
      const data = await getBootstrapData();
      if (!data || !data.events) {
        throw new Error('No events data in bootstrap response');
      }
      return data.events;
    } catch (error) {
      console.error('Failed to get bootstrap events:', error);
      throw error;
    }
  };

  const getBootstrapPhases = async (): Promise<PhaseResponse[]> => {
    try {
      const data = await getBootstrapData();
      if (!data || !data.phases) {
        throw new Error('No phases data in bootstrap response');
      }
      return data.phases;
    } catch (error) {
      console.error('Failed to get bootstrap phases:', error);
      throw error;
    }
  };

  const getBootstrapTeams = async (): Promise<TeamResponse[]> => {
    try {
      const data = await getBootstrapData();
      if (!data || !data.teams) {
        throw new Error('No teams data in bootstrap response');
      }
      return data.teams;
    } catch (error) {
      console.error('Failed to get bootstrap teams:', error);
      throw error;
    }
  };

  const getBootstrapElements = async (): Promise<ElementResponse[]> => {
    try {
      const data = await getBootstrapData();
      if (!data || !data.elements) {
        throw new Error('No elements data in bootstrap response');
      }
      return data.elements;
    } catch (error) {
      console.error('Failed to get bootstrap elements:', error);
      throw error;
    }
  };

  return {
    getBootstrapData,
    getBootstrapEvents,
    getBootstrapPhases,
    getBootstrapTeams,
    getBootstrapElements,
  };
};
