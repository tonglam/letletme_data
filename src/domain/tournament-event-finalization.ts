export type TournamentEventFinalizationOptions = {
  refreshAlways: boolean;
  finish: (eventId: number) => Promise<number>;
  refresh: () => Promise<unknown>;
  invalidate: (reason: string) => Promise<unknown>;
};

/** Publish canonical lifecycle state before refreshing snapshots and caches. */
export async function finalizeTournamentEventLifecycle(
  eventId: number,
  options: TournamentEventFinalizationOptions,
): Promise<number> {
  const finished = eventId > 0 ? await options.finish(eventId) : 0;

  if (options.refreshAlways || finished > 0) {
    await options.refresh();
    // A previous attempt can commit `state = finished` and then fail during
    // refresh or cache invalidation. On retry `finish()` returns zero, but the
    // refreshed materialized views still must not sit behind stale GraphQL
    // cache entries. Invalidation is therefore paired with every successful
    // publication refresh, not only with the first state transition.
    await options.invalidate(finished > 0 ? 'finish' : 'event-publication');
  }
  return finished;
}
