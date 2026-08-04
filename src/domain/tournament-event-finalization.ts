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
  }
  if (finished > 0) {
    await options.invalidate('finish');
  }
  return finished;
}
