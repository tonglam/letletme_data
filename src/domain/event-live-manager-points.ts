import type { EventLive } from './event-lives';
import type { RawFPLEntryEventPicksResponse, RawFPLEventLiveResponse } from '../types';

export type AssistantManagerPointsFact = Readonly<{
  points: number;
  livePublicationId: string;
  liveGeneration: number;
  liveScoreCoreRevision: string;
}>;

export type LiveScoreObservation = Readonly<{
  eventLives: readonly Pick<EventLive, 'elementId' | 'totalPoints'>[];
  publication: Readonly<{
    publicationId: string;
    generation: number;
    revisions: Readonly<{
      scoreCore: Readonly<{ revision: string }>;
    }>;
  }>;
}>;

/**
 * Reconcile the manager-only total from one provider event-live response.
 *
 * The Redis publication supplies the revision fence, but it is not a source
 * observation for the subtraction: using its player subtotal together with a
 * later `entry_history.points` response can manufacture a plausible yet
 * incorrect Assistant Manager delta. Require the provider response used for
 * the subtraction to agree with the exact current Redis authority for every
 * selected player before binding the fact to that revision.
 */
export function assistantManagerPointsFactFromProviderObservation(
  picks: RawFPLEntryEventPicksResponse,
  providerLive: RawFPLEventLiveResponse,
  observation: LiveScoreObservation,
): AssistantManagerPointsFact | null {
  const providerByElement = new Map<number, number>();
  for (const element of providerLive.elements) {
    if (
      providerByElement.has(element.id) ||
      !Number.isSafeInteger(element.id) ||
      !Number.isSafeInteger(element.stats.total_points)
    ) {
      return null;
    }
    providerByElement.set(element.id, element.stats.total_points);
  }
  const authorityByElement = new Map(
    observation.eventLives.map((row) => [row.elementId, row] as const),
  );
  let playerPoints = 0;
  for (const pick of picks.picks) {
    const providerPoints = providerByElement.get(pick.element);
    const authority = authorityByElement.get(pick.element);
    // The provider observation and the Redis score authority must describe
    // the same selected-player totals. Otherwise the gameweek may have
    // advanced between the two reads; fail closed and let the next poll retry.
    if (
      providerPoints === undefined ||
      !authority ||
      !Number.isSafeInteger(authority.totalPoints) ||
      authority.totalPoints !== providerPoints
    ) {
      return null;
    }
    if (!Number.isSafeInteger(pick.multiplier) || pick.multiplier < 0 || pick.multiplier > 3) {
      return null;
    }
    playerPoints += providerPoints * pick.multiplier;
  }
  const points = picks.entry_history.points - playerPoints;
  if (!Number.isSafeInteger(points) || points < 0) return null;
  return {
    points,
    livePublicationId: observation.publication.publicationId,
    liveGeneration: observation.publication.generation,
    liveScoreCoreRevision: observation.publication.revisions.scoreCore.revision,
  };
}
