import {
  contentHttpAcquisitionQueueName,
  dataRepairQueueName,
  dataGovernanceQueueName,
  dataSyncQueueName,
  entryOnboardingQueueName,
  entrySyncQueueName,
  fplCriticalSyncQueueName,
  fplPriceWatchQueueName,
  housekeepingQueueName,
  leagueSyncQueueName,
  liveDataQueueName,
  livePicksQueueName,
  maintenanceQueueName,
  myFplOrchestrationQueueName,
  officialH2hLiveQueueName,
  publicationOutboxQueueName,
  queueNames,
  contentQueueNames,
} from '../queues/names';

/**
 * My FPL finalization has one time contract shared by Data, GraphQL and Ops.
 * Keep the numbers here so a status endpoint cannot drift from the worker's
 * scheduler policy.
 */
export const MY_FPL_FINALIZATION_DISPATCH_WITHIN_MS = 15 * 60_000;
export const MY_FPL_FINALIZATION_EXECUTION_BUDGET_MS = 60 * 60_000;
export const MY_FPL_FINALIZATION_TOTAL_SLA_MS = 4_500_000;
export const MY_FPL_FINALIZATION_DEPENDENCY_RETRY_MS = 60_000;
export const MY_FPL_FINALIZATION_BULL_ATTEMPTS = 3;
export const MY_FPL_SNAPSHOT_OUTBOX_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;

export type ContractVisibility =
  | 'public'
  | 'internal-only'
  | 'delegated-control-plane'
  | 'excluded';

export type DataContract = Readonly<{
  contractKey: string;
  dataset: string;
  lifecycleStages: readonly ('preseason' | 'active' | 'review' | 'finished' | 'idle')[];
  eligibility: string;
  queueLane: string;
  schedulerJobs: readonly string[];
  dispatchWithinMs: number;
  executionBudgetMs: number;
  /** Evidence writer currently attached to this contract's producer. */
  freshnessEvidence?: 'publication' | 'checkpoint' | 'none';
  /**
   * Scheduler definitions that own an SLO window for this contract.  A
   * contract can cover more jobs than its user-visible checkpoint (for
   * example entry onboarding and transfers), so the list keeps internal
   * maintenance obligations out of the public freshness denominator.
   */
  freshnessJobs?: readonly string[];
  integrity: string;
  publicationEvidence: readonly string[];
  consumerEvidence: Readonly<{
    redis?: string;
    graphql?: string;
    web?: string;
  }>;
  retry: Readonly<{ maxGenerations: number; policy: string }>;
  compensator: string;
  visibility: ContractVisibility;
  /**
   * Required for contracts which intentionally have no public consumer.  A
   * reason keeps internal/excluded work visible in the catalog and prevents a
   * future definition from silently escaping the cross-stack audit.
   */
  visibilityReason?: string;
}>;

const publicConsumers = (graphql: string, web: string) => ({ graphql, web });

/**
 * The registry is intentionally data-only.  It is imported by CI, status
 * endpoints and workers, so it must not open a database connection or read
 * mutable runtime state during module initialisation.
 */
export const dataContractRegistry = [
  {
    contractKey: 'core-fixtures',
    dataset: 'fpl:core',
    lifecycleStages: ['preseason', 'active', 'review', 'finished', 'idle'],
    eligibility: 'authoritative bootstrap/core source is available',
    queueLane: dataSyncQueueName,
    schedulerJobs: ['core-current-reconcile', 'core-snapshot'],
    dispatchWithinMs: 60_000,
    executionBudgetMs: 5 * 60_000,
    freshnessEvidence: 'publication',
    integrity: 'teams/events/fixtures complete for the source revision',
    publicationEvidence: ['ops.dataset_publications active', 'checksum', 'Redis pointer'],
    consumerEvidence: publicConsumers('coreEventContext', 'homePublicBootstrap'),
    retry: { maxGenerations: 3, policy: 'bounded transient retry; no partial publication' },
    compensator: 'core publication reconcile',
    visibility: 'public',
  },
  {
    contractKey: 'market-price',
    dataset: 'fpl:market',
    lifecycleStages: ['active', 'review', 'idle'],
    eligibility: 'current source day only; historical replay requires archived bootstrap',
    queueLane: dataSyncQueueName,
    schedulerJobs: [
      'market-daily',
      'player-prices',
      'price-change-predictions',
      'price-change-watch',
      'player-market-freshness-watchdog',
    ],
    dispatchWithinMs: 10 * 60_000,
    executionBudgetMs: 10 * 60_000,
    freshnessEvidence: 'publication',
    integrity: 'expected player count equals observed count and source-day lineage matches',
    publicationEvidence: ['source artifact bytes/SHA', 'market rows', 'active publication'],
    consumerEvidence: publicConsumers('marketSnapshotContext/priceChangeBoard', 'market pages'),
    retry: { maxGenerations: 6, policy: 'same source day only' },
    compensator: 'market freshness reconcile or protected archive replay',
    visibility: 'public',
  },
  {
    contractKey: 'live-snapshot',
    dataset: 'redis:v2:fpl:live',
    lifecycleStages: ['active', 'review', 'finished'],
    eligibility: 'event live or GW review checkpoint',
    queueLane: liveDataQueueName,
    schedulerJobs: ['live-snapshot', 'live-finalization'],
    dispatchWithinMs: 30_000,
    executionBudgetMs: 90_000,
    freshnessEvidence: 'publication',
    integrity: 'event roster and all fixture groups are complete',
    publicationEvidence: ['Redis V2 current/previous publication', 'V2 event checkpoint'],
    consumerEvidence: publicConsumers('liveSnapshot/gameweekDesk', 'live pages'),
    retry: { maxGenerations: 2, policy: 'latest desired generation wins' },
    compensator: 'merged V2 checkpoint obligation and exact-event repair',
    visibility: 'public',
  },
  {
    contractKey: 'entry-data',
    dataset: 'competition:entry',
    lifecycleStages: ['active', 'review', 'finished'],
    eligibility: 'started_event IS NULL OR started_event <= event_id',
    queueLane: entrySyncQueueName,
    schedulerJobs: [
      'entry-info',
      'entry-picks',
      'entry-transfers',
      'entry-results',
      'entry-onboarding',
    ],
    dispatchWithinMs: 15 * 60_000,
    executionBudgetMs: 15 * 60_000,
    integrity: 'eligible entries covered; picks contain exactly 15 unique positions',
    freshnessEvidence: 'checkpoint',
    freshnessJobs: ['entry-picks', 'entry-results'],
    publicationEvidence: ['entry checkpoint', 'sync run finalizer'],
    consumerEvidence: publicConsumers('entry and My FPL loaders', 'entry/live pages'),
    retry: { maxGenerations: 3, policy: 'failed IDs and keyset continuation inherit lane' },
    compensator: 'failed-ID retry and keyset continuation',
    visibility: 'public',
  },
  {
    contractKey: 'live-final-retention',
    dataset: 'redis:v2:fpl:live:final-retention',
    lifecycleStages: ['review', 'finished'],
    eligibility: 'the unique current event is finished and data_checked is true',
    queueLane: liveDataQueueName,
    schedulerJobs: ['live-final-retention'],
    dispatchWithinMs: 15 * 60_000,
    executionBudgetMs: 60 * 60_000,
    freshnessEvidence: 'none',
    integrity:
      'current final global/match/entry/league publication identities are checkpoint-correct and every required Redis item retains more than 24 hours',
    publicationEvidence: ['Redis final lease CAS', 'PostgreSQL final checkpoint/head identity'],
    consumerEvidence: {},
    retry: {
      maxGenerations: 3,
      policy: 'CAS-only TTL renewal or exact durable restore; identity conflicts fail closed',
    },
    compensator: 'bounded current-event final retention reconcile',
    visibility: 'internal-only',
    visibilityReason:
      'Internal lease maintenance for public live publications; it is not a separate consumer dataset.',
  },
  {
    contractKey: 'live-picks',
    dataset: 'competition:live-entry-picks',
    lifecycleStages: ['active', 'review'],
    eligibility: 'source canary available; started_event IS NULL OR started_event <= event_id',
    queueLane: livePicksQueueName,
    schedulerJobs: ['live-picks-refresh'],
    dispatchWithinMs: 30_000,
    executionBudgetMs: 10 * 60_000,
    integrity: 'all eligible entries contain exactly 15 unique pick positions',
    freshnessEvidence: 'checkpoint',
    freshnessJobs: ['live-picks-refresh'],
    publicationEvidence: ['entry event picks rows', 'sync run finalizer'],
    consumerEvidence: publicConsumers('entry/live and My FPL loaders', 'live pages'),
    retry: {
      maxGenerations: 2,
      policy: 'per-entry latest desired input with exact child retries; no cohort sweep',
    },
    compensator: 'failed-ID retry, per-entry single-flight repair, and keyset continuation',
    visibility: 'public',
  },
  {
    contractKey: 'league-tournament',
    dataset: 'competition:league-tournament',
    lifecycleStages: ['active', 'review', 'finished'],
    eligibility: 'eligible roster entries for event',
    queueLane: leagueSyncQueueName,
    schedulerJobs: [
      'tournament-roster',
      'tournament-info',
      'league-event-picks',
      'league-event-results',
      'tournament-event-picks',
      'tournament-event-results',
      'tournament-transfers-pre',
      'tournament-materialized-views-refresh',
    ],
    dispatchWithinMs: 15 * 60_000,
    executionBudgetMs: 20 * 60_000,
    integrity: 'checkpoint and cascade barrier cover eligible tournament scope',
    freshnessEvidence: 'checkpoint',
    freshnessJobs: [
      'league-event-picks',
      'league-event-results',
      'tournament-event-picks',
      'tournament-event-results',
    ],
    publicationEvidence: ['sync checkpoint', 'queue-run barrier', 'cascade finalizer'],
    consumerEvidence: publicConsumers('tournament desk and competitions', 'tournament pages'),
    retry: { maxGenerations: 3, policy: 'bounded retry plus finalizer' },
    compensator: 'checkpoint reconcile and failed IDs',
    visibility: 'public',
  },
  {
    contractKey: 'my-fpl',
    dataset: 'my-fpl:snapshot',
    lifecycleStages: ['active', 'review', 'finished', 'idle'],
    eligibility: 'eligible entries and active tournaments',
    queueLane: myFplOrchestrationQueueName,
    schedulerJobs: [
      'my-fpl-snapshot',
      'my-fpl-finalization',
      'my-fpl-snapshot-outbox',
      'post-match-consolidation',
    ],
    dispatchWithinMs: MY_FPL_FINALIZATION_DISPATCH_WITHIN_MS,
    executionBudgetMs: MY_FPL_FINALIZATION_EXECUTION_BUDGET_MS,
    integrity:
      'current eligible scope, identity/rank/picks/transfers checkpoints and tournament scope are complete; FINAL matches the observed scope',
    freshnessEvidence: 'checkpoint',
    freshnessJobs: [
      'my-fpl-snapshot',
      'my-fpl-finalization',
      'my-fpl-snapshot-outbox',
      'post-match-consolidation',
    ],
    publicationEvidence: ['active snapshot revision', 'scope manifest', 'outbox'],
    consumerEvidence: {
      ...publicConsumers('MyFplSnapshotMeta', 'My FPL pages'),
      // My FPL is published through an immutable Redis manifest/outbox before
      // the GraphQL and Web loaders can observe the active snapshot. Keep that
      // hop in the freshness contract so a PostgreSQL-only checkpoint cannot
      // be reported as consumer-ready.
      redis: 'active snapshot manifest and publication outbox',
    },
    retry: {
      maxGenerations: 6,
      policy:
        'three Bull execution attempts with 60/120 second backoff; prerequisite waits defer without consuming an attempt',
    },
    compensator: 'snapshot rebuild and outbox reconcile',
    visibility: 'public',
  },
  {
    contractKey: 'my-tournament-review-v2.1',
    dataset: 'competition:my-tournament-review-v2.1',
    lifecycleStages: ['active', 'review', 'finished', 'idle'],
    eligibility: 'finished + data_checked event and setup-ready tournament phase',
    queueLane: myFplOrchestrationQueueName,
    schedulerJobs: ['tournament-review-v2'],
    // The review job shares the My FPL orchestration lane. Keep the lane's
    // established dispatch budget stable; its five-minute scheduler cadence
    // is independent from the queue deadline used for backlog classification.
    dispatchWithinMs: 15 * 60_000,
    executionBudgetMs: 15 * 60_000,
    freshnessEvidence: 'checkpoint',
    freshnessJobs: ['tournament-review-v2'],
    integrity:
      'one immutable publication and head per season/tournament/event; typed format counts and source watermark agree',
    publicationEvidence: ['tournament_review_publications', 'tournament_review_heads'],
    consumerEvidence: publicConsumers(
      'myTournamentReviewCatalog/myTournamentGameweekReview/myTournamentSeasonReview/myTournamentReviewStatus',
      'My Tournament Review V2 pages',
    ),
    retry: {
      maxGenerations: 3,
      policy: 'source recheck 60/180/600s, then 15-minute degraded repair for 24h',
    },
    compensator: 'scoped obligation reconcile and idempotent revision rebuild',
    visibility: 'public',
  },
  {
    contractKey: 'official-h2h',
    dataset: 'competition:official-h2h',
    lifecycleStages: ['active', 'review', 'finished'],
    eligibility: 'locked schedule manifest or full seed required',
    queueLane: officialH2hLiveQueueName,
    schedulerJobs: ['tournament-official-h2h-live'],
    dispatchWithinMs: 15_000,
    executionBudgetMs: 45_000,
    integrity: 'locked page manifest, standings and current-event matches agree',
    freshnessEvidence: 'checkpoint',
    freshnessJobs: ['tournament-official-h2h-live'],
    publicationEvidence: ['page manifest', 'schedule hash', 'atomic tournament publication'],
    consumerEvidence: publicConsumers('official H2H envelope', 'tournament detail/home'),
    retry: { maxGenerations: 2, policy: 'one root per event minute' },
    compensator: 'deduplicated full reconciliation',
    visibility: 'public',
  },
  {
    contractKey: 'player-stats',
    dataset: 'fpl:player-stats',
    lifecycleStages: ['active', 'review', 'finished', 'idle'],
    eligibility: 'current core player IDs',
    queueLane: dataRepairQueueName,
    schedulerJobs: [
      'player-stats',
      'player-season-summary-repair',
      'understat-orphan-reconciler',
      'understat-team-incremental',
      'understat-player-incremental',
    ],
    dispatchWithinMs: 15 * 60_000,
    executionBudgetMs: 75 * 60_000,
    integrity: 'current core player IDs fully represented with provider lineage',
    freshnessEvidence: 'checkpoint',
    freshnessJobs: ['player-stats', 'player-season-summary-repair'],
    publicationEvidence: ['sync run checkpoint'],
    consumerEvidence: publicConsumers('player stats contexts', 'player stats/detail'),
    retry: { maxGenerations: 3, policy: 'bounded repair' },
    compensator: 'failed IDs and orphan reconcile',
    visibility: 'public',
  },
  {
    contractKey: 'content',
    dataset: 'content',
    lifecycleStages: ['active', 'review', 'finished', 'idle'],
    eligibility: 'source schedule checkpoint',
    queueLane: contentHttpAcquisitionQueueName,
    schedulerJobs: ['content-acquisition'],
    dispatchWithinMs: 15 * 60_000,
    executionBudgetMs: 30 * 60_000,
    integrity: 'source schedule/job outbox checkpoint',
    publicationEvidence: ['content source_schedules', 'job_outbox'],
    consumerEvidence: { graphql: 'Briefing GraphQL', web: 'Briefing loaders' },
    retry: { maxGenerations: 3, policy: 'content worker lease' },
    compensator: 'content outbox reconcile',
    visibility: 'delegated-control-plane',
  },
  {
    contractKey: 'housekeeping',
    dataset: 'ops:housekeeping',
    lifecycleStages: ['active', 'review', 'finished', 'idle'],
    eligibility: 'internal schedule',
    queueLane: housekeepingQueueName,
    schedulerJobs: [
      'bug-report-cleanup',
      'bug-report-screenshot-retention',
      'client-signal-retention',
      'launch-monitor',
    ],
    dispatchWithinMs: 60 * 60_000,
    executionBudgetMs: 60 * 60_000,
    integrity: 'internal checkpoint',
    publicationEvidence: ['ops checkpoint'],
    consumerEvidence: {},
    retry: { maxGenerations: 3, policy: 'bounded retry' },
    compensator: 'housekeeping reconcile',
    visibility: 'internal-only',
    visibilityReason: 'Operations-only maintenance checkpoints; no user-facing dataset.',
  },
  {
    contractKey: 'public-league-trends',
    dataset: 'competition:tournament-trends',
    lifecycleStages: ['active', 'review', 'finished', 'idle'],
    eligibility: 'mechanical migration only',
    queueLane: dataRepairQueueName,
    schedulerJobs: ['tournament-trends-repair'],
    dispatchWithinMs: 60 * 60_000,
    executionBudgetMs: 60 * 60_000,
    integrity: 'excluded from this acceptance cycle',
    publicationEvidence: ['internal repair checkpoint'],
    consumerEvidence: {},
    retry: { maxGenerations: 3, policy: 'bounded repair' },
    compensator: 'repair lane reconcile',
    visibility: 'excluded',
    visibilityReason:
      'Explicitly excluded from this acceptance cycle; retained only for mechanical repair migration.',
  },
  {
    contractKey: 'bootstrap-archive',
    dataset: 'fpl:bootstrap-static-archive',
    lifecycleStages: ['active', 'review', 'finished', 'idle'],
    eligibility: 'publication source day',
    queueLane: dataSyncQueueName,
    schedulerJobs: [],
    dispatchWithinMs: 10 * 60_000,
    executionBudgetMs: 10 * 60_000,
    integrity: 'exact source day, bytes, SHA-256, schema and item counts',
    publicationEvidence: ['ops.fpl_source_artifacts'],
    consumerEvidence: {},
    retry: { maxGenerations: 6, policy: 'no replay without archived artifact' },
    compensator: 'protected source-day replay',
    visibility: 'internal-only',
    visibilityReason:
      'Internal immutable source evidence used to validate source-day replay; not a user-facing dataset.',
  },
] as const satisfies readonly DataContract[];

export const canonicalQueueCatalog = [...queueNames, ...contentQueueNames] as const;

export type CanonicalQueueName = (typeof canonicalQueueCatalog)[number];
export type ContractKey = (typeof dataContractRegistry)[number]['contractKey'];

/** Return a contract through the widened schema type used by runtime code. */
export function findDataContract(contractKey: string): DataContract | undefined {
  return dataContractRegistry.find((contract) => contract.contractKey === contractKey) as
    | DataContract
    | undefined;
}

/** Runtime inventory used by CI/status/quiescence checks. Keep this list
 * explicit: adding a consumer without adding its operational owner is a
 * production safety bug, not merely a documentation omission. */
export const queueRuntimeCatalog = [
  { queueName: dataSyncQueueName, service: 'queue-worker', serviceClass: 'data-sync' },
  {
    queueName: fplCriticalSyncQueueName,
    service: 'fpl-critical-worker',
    serviceClass: 'fpl-critical',
  },
  {
    queueName: fplPriceWatchQueueName,
    service: 'fpl-price-watch-worker',
    serviceClass: 'fpl-price-watch',
  },
  { queueName: entrySyncQueueName, service: 'queue-worker', serviceClass: 'entry-sync' },
  { queueName: leagueSyncQueueName, service: 'queue-worker', serviceClass: 'league-sync' },
  { queueName: liveDataQueueName, service: 'queue-worker', serviceClass: 'live-data' },
  { queueName: 'tournament-sync', service: 'queue-worker', serviceClass: 'tournament-sync' },
  { queueName: 'tournament-setup', service: 'queue-worker', serviceClass: 'tournament-setup' },
  { queueName: 'tournament-repair', service: 'queue-worker', serviceClass: 'tournament-repair' },
  { queueName: 'understat-player-sync', service: 'queue-worker', serviceClass: 'understat' },
  { queueName: 'understat-team-sync', service: 'queue-worker', serviceClass: 'understat' },
  { queueName: maintenanceQueueName, service: 'queue-worker', serviceClass: 'maintenance-drain' },
  { queueName: livePicksQueueName, service: 'live-picks-worker', serviceClass: 'live-picks' },
  {
    queueName: officialH2hLiveQueueName,
    service: 'official-h2h-worker',
    serviceClass: 'official-h2h',
  },
  {
    queueName: myFplOrchestrationQueueName,
    service: 'queue-worker',
    serviceClass: 'maintenance-lane',
  },
  {
    queueName: publicationOutboxQueueName,
    service: 'queue-worker',
    serviceClass: 'maintenance-lane',
  },
  {
    queueName: entryOnboardingQueueName,
    service: 'queue-worker',
    serviceClass: 'maintenance-lane',
  },
  { queueName: dataRepairQueueName, service: 'queue-worker', serviceClass: 'maintenance-lane' },
  { queueName: housekeepingQueueName, service: 'queue-worker', serviceClass: 'maintenance-lane' },
  { queueName: dataGovernanceQueueName, service: 'queue-worker', serviceClass: 'data-governance' },
  {
    queueName: contentHttpAcquisitionQueueName,
    service: 'content-worker',
    serviceClass: 'content',
  },
  { queueName: 'content-media-transcript', service: 'content-worker', serviceClass: 'content' },
  { queueName: 'content-x-scan', service: 'content-worker', serviceClass: 'content' },
] as const;

export function assertQueueRuntimeCatalog(): void {
  const canonical = new Set<string>(canonicalQueueCatalog);
  const runtime: string[] = queueRuntimeCatalog.map((item) => item.queueName);
  const missing = [...canonical].filter((queueName) => !runtime.includes(queueName));
  const extra = [...new Set(runtime)].filter((queueName) => !canonical.has(queueName));
  const duplicate = runtime.filter((queueName, index) => runtime.indexOf(queueName) !== index);
  if (missing.length > 0 || extra.length > 0 || duplicate.length > 0) {
    throw new Error(
      `Queue runtime catalog mismatch: missing=${missing.join(',')} extra=${extra.join(',')} duplicate=${duplicate.join(',')}`,
    );
  }
}

const schedulerJobSet: Set<string> = new Set(
  dataContractRegistry.flatMap((contract) => contract.schedulerJobs),
);

/** Contract jobs deliberately triggered by an API/event path rather than the
 * 30-second scheduler. They still need a lane, retry and consumer contract,
 * but must not be mistaken for an omitted scheduler definition. */
export const MANUAL_ONLY_CONTRACT_JOBS = ['entry-onboarding'] as const;

export function contractForSchedulerJob(jobName: string): DataContract | undefined {
  return dataContractRegistry.find((contract) =>
    (contract.schedulerJobs as readonly string[]).includes(jobName),
  );
}

/** Whether a scheduler definition owns a machine-settled freshness window. */
export function contractHasFreshnessWindow(contract: DataContract, jobName: string): boolean {
  if (!contract.freshnessEvidence || contract.freshnessEvidence === 'none') return false;
  return contract.freshnessJobs === undefined || contract.freshnessJobs.includes(jobName);
}

/**
 * Consumer evidence is required only when the contract names both sides of
 * the public read path.  Keeping this decision in the registry prevents the
 * global probe feature flag from accidentally making internal checkpoints
 * wait for GraphQL/Web milestones that do not exist.
 */
export function contractHasConsumerEvidence(contract: DataContract): boolean {
  return (
    typeof contract.consumerEvidence.graphql === 'string' &&
    contract.consumerEvidence.graphql.trim().length > 0 &&
    typeof contract.consumerEvidence.web === 'string' &&
    contract.consumerEvidence.web.trim().length > 0
  );
}

/** Resolve the concrete queue lane for a contract job. A contract can span
 * several lanes (for example My FPL orchestration versus its publication
 * outbox), so governance cases must not blindly use the contract's primary
 * lane when selecting a repair target. */
export function queueLaneForSchedulerJob(jobName: string): string | undefined {
  const explicit: Record<string, string> = {
    'player-stats': dataSyncQueueName,
    'player-season-summary-repair': dataRepairQueueName,
    'understat-orphan-reconciler': dataRepairQueueName,
    'understat-team-incremental': 'understat-team-sync',
    'understat-player-incremental': 'understat-player-sync',
    'tournament-official-h2h-live': officialH2hLiveQueueName,
    'tournament-materialized-views-refresh': 'tournament-sync',
    'live-picks-refresh': livePicksQueueName,
    'my-fpl-snapshot': myFplOrchestrationQueueName,
    'my-fpl-finalization': myFplOrchestrationQueueName,
    'post-match-consolidation': myFplOrchestrationQueueName,
    'tournament-review-v2': myFplOrchestrationQueueName,
    'my-fpl-snapshot-outbox': publicationOutboxQueueName,
    'entry-onboarding': entryOnboardingQueueName,
    'tournament-trends-repair': dataRepairQueueName,
    'player-market-freshness-watchdog': dataRepairQueueName,
    'price-change-watch': fplPriceWatchQueueName,
    'bug-report-cleanup': housekeepingQueueName,
    'bug-report-screenshot-retention': housekeepingQueueName,
    'client-signal-retention': housekeepingQueueName,
    'launch-monitor': housekeepingQueueName,
  };
  return explicit[jobName] ?? contractForSchedulerJob(jobName)?.queueLane;
}

export function assertDataContractRegistry(jobNames: readonly string[]): void {
  assertQueueRuntimeCatalog();
  const manualOnly = new Set<string>(MANUAL_ONLY_CONTRACT_JOBS);
  const provided = new Set(jobNames);
  const missing = jobNames.filter((jobName) => !schedulerJobSet.has(jobName));
  const unrepresented = [...schedulerJobSet].filter(
    (jobName) => !manualOnly.has(jobName) && !provided.has(jobName),
  );
  const invalidManualOnly = MANUAL_ONLY_CONTRACT_JOBS.filter(
    (jobName) => !schedulerJobSet.has(jobName),
  );
  const duplicates = [...new Set(jobNames)].filter(
    (jobName) =>
      dataContractRegistry.filter((contract) =>
        (contract.schedulerJobs as readonly string[]).includes(jobName),
      ).length > 1,
  );
  const contracts: readonly DataContract[] = dataContractRegistry;
  const invalidFreshnessJobs = contracts.flatMap((contract) =>
    (contract.freshnessJobs ?? [])
      .filter((jobName) => !(contract.schedulerJobs as readonly string[]).includes(jobName))
      .map((jobName) => `${contract.contractKey}:${jobName}`),
  );
  const checkpointContractsWithoutJobs = contracts
    .filter(
      (contract) =>
        contract.freshnessEvidence === 'checkpoint' &&
        (!contract.freshnessJobs || contract.freshnessJobs.length === 0),
    )
    .map((contract) => contract.contractKey);
  const contractsMissingVisibilityReason = contracts
    .filter(
      (contract) =>
        (contract.visibility === 'internal-only' || contract.visibility === 'excluded') &&
        (!contract.visibilityReason || contract.visibilityReason.trim().length === 0),
    )
    .map((contract) => contract.contractKey);
  const publicFreshnessContractsMissingConsumerEvidence = contracts
    .filter(
      (contract) =>
        contract.visibility === 'public' &&
        (contract.freshnessEvidence === 'checkpoint' ||
          contract.freshnessEvidence === 'publication') &&
        !contractHasConsumerEvidence(contract),
    )
    .map((contract) => contract.contractKey);
  if (
    missing.length > 0 ||
    unrepresented.length > 0 ||
    invalidManualOnly.length > 0 ||
    duplicates.length > 0 ||
    invalidFreshnessJobs.length > 0 ||
    checkpointContractsWithoutJobs.length > 0 ||
    contractsMissingVisibilityReason.length > 0 ||
    publicFreshnessContractsMissingConsumerEvidence.length > 0
  ) {
    throw new Error(
      [
        missing.length > 0 ? `Scheduler jobs missing data contracts: ${missing.join(', ')}` : '',
        unrepresented.length > 0
          ? `Contract jobs missing scheduler definitions: ${unrepresented.join(', ')}`
          : '',
        invalidManualOnly.length > 0
          ? `Manual-only jobs missing from contract registry: ${invalidManualOnly.join(', ')}`
          : '',
        duplicates.length > 0
          ? `Scheduler jobs have multiple data contracts: ${duplicates.join(', ')}`
          : '',
        invalidFreshnessJobs.length > 0
          ? `Freshness jobs are outside their contract scheduler jobs: ${invalidFreshnessJobs.join(', ')}`
          : '',
        checkpointContractsWithoutJobs.length > 0
          ? `Checkpoint contracts missing freshness job mappings: ${checkpointContractsWithoutJobs.join(', ')}`
          : '',
        contractsMissingVisibilityReason.length > 0
          ? `Internal/excluded contracts missing visibility reasons: ${contractsMissingVisibilityReason.join(', ')}`
          : '',
        publicFreshnessContractsMissingConsumerEvidence.length > 0
          ? `Public freshness contracts missing GraphQL/Web evidence: ${publicFreshnessContractsMissingConsumerEvidence.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('; '),
    );
  }
}
