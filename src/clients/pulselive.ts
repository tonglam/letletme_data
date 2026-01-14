import { z } from 'zod';

import type { RawPulseLiveStandingsResponse } from '../types';
import { FPLClientError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

class PulseliveClient {
  private readonly baseUrl = 'https://footballapi.pulselive.com/football';

  async getStandings(compSeason: string): Promise<RawPulseLiveStandingsResponse> {
    const url = `${this.baseUrl}/standings?compSeasons=${compSeason}`;

    try {
      logInfo('Fetching Pulselive standings', { compSeason, url });

      const response = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://www.premierleague.com',
          Referer: 'https://www.premierleague.com/tables',
        },
      });

      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      const StandingsClubSchema = z.object({ abbr: z.string() }).passthrough();
      const StandingsTeamSchema = z.object({ club: StandingsClubSchema }).passthrough();
      const StandingsOverallSchema = z
        .object({
          points: z.number(),
          played: z.number(),
          won: z.number(),
          drawn: z.number(),
          lost: z.number(),
          goalsFor: z.number(),
          goalsAgainst: z.number(),
          goalsDifference: z.number(),
        })
        .passthrough();
      const StandingsEntrySchema = z
        .object({
          position: z.number(),
          team: StandingsTeamSchema,
          overall: StandingsOverallSchema,
        })
        .passthrough();
      const StandingsTableSchema = z
        .object({ entries: z.array(StandingsEntrySchema) })
        .passthrough();
      const StandingsSchema = z.object({ tables: z.array(StandingsTableSchema) }).passthrough();

      const validated = StandingsSchema.parse(data);
      logInfo('Successfully fetched Pulselive standings', {
        compSeason,
        tableCount: validated.tables.length,
      });

      return validated as RawPulseLiveStandingsResponse;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('Pulselive standings validation failed', error);
        throw new FPLClientError(
          'Invalid standings response format',
          undefined,
          'VALIDATION_ERROR',
          error,
        );
      }

      if (error instanceof FPLClientError) {
        logError('Pulselive client error', error);
        throw error;
      }

      logError('Unexpected error fetching Pulselive standings', error);
      throw new FPLClientError(
        'Failed to fetch Pulselive standings',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

export const pulseliveClient = new PulseliveClient();
