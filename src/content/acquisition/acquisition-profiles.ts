export const SOURCE_TYPES = [
  'OFFICIAL_FPL',
  'LEAGUE_OFFICIAL',
  'CLUB_OFFICIAL',
  'PLAYER_OFFICIAL',
  'REPORTER',
  'CREATOR',
  'PUBLICATION',
  'SHOW',
  'AGGREGATOR',
  'DISCOVERED_UNKNOWN',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const ADAPTER_KINDS = [
  'X_ACCOUNT',
  'X_SEMANTIC',
  'RSS_ATOM',
  'PODCAST_FEED',
  'YOUTUBE_CHANNEL',
] as const;

export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export const X_ACQUISITION_LANES = [
  'OFFICIAL',
  'CLUB',
  'REPORTER',
  'CREATOR',
  'LONGFORM',
  'SEMANTIC',
] as const;

export type XAcquisitionLane = (typeof X_ACQUISITION_LANES)[number];

export const CLUB_COVERAGE_ROLES = [
  'OFFICIAL',
  'PRIMARY_REPORTING',
  'SECONDARY_REPORTING',
] as const;

export type ClubCoverageRole = (typeof CLUB_COVERAGE_ROLES)[number];

export type AcquisitionPhase = 'NORMAL' | 'APPROACHING' | 'FINAL90';

export type AcquisitionProfile = Readonly<{
  profileKey: string;
  revision: number;
  adapterKind: AdapterKind;
  lane: XAcquisitionLane | 'FEED' | 'PODCAST' | 'YOUTUBE';
  priority: number;
  cadenceMinutes: Readonly<Record<AcquisitionPhase, number>>;
  bootstrap: Readonly<{
    lookbackMinutes: number;
    maxItems: number;
    maxContentJobs: number;
  }>;
  saturationThreshold?: number;
  partitionMaxMembers?: number;
}>;

type XProfileInput = Omit<AcquisitionProfile, 'adapterKind' | 'revision' | 'bootstrap'> & {
  bootstrapLookbackMinutes?: number;
  revision?: number;
};

const xProfile = (input: XProfileInput): AcquisitionProfile => {
  let partitionMaxMembers = 2;
  if (input.lane === 'OFFICIAL') partitionMaxMembers = 1;
  if (input.lane === 'CREATOR' || input.lane === 'LONGFORM') partitionMaxMembers = 10;
  return {
    ...input,
    adapterKind: 'X_ACCOUNT',
    revision: input.revision ?? 1,
    bootstrap: {
      lookbackMinutes: input.bootstrapLookbackMinutes ?? 360,
      maxItems: 10,
      maxContentJobs: 0,
    },
    saturationThreshold: 10,
    partitionMaxMembers,
  };
};

// Keep the account cadence at one pass per 24 hours.  The request-window
// bound is widened in the scheduler to absorb normal provider latency and
// scheduler jitter without forcing a second pass in the same day.
const DAILY_X_ACCOUNT_CADENCE_MINUTES = 24 * 60;
const DAILY_X_ACCOUNT_BOOTSTRAP_LOOKBACK_MINUTES = 26 * 60;
const dailyXAccountCadence = {
  NORMAL: DAILY_X_ACCOUNT_CADENCE_MINUTES,
  APPROACHING: DAILY_X_ACCOUNT_CADENCE_MINUTES,
  FINAL90: DAILY_X_ACCOUNT_CADENCE_MINUTES,
} as const;

const dailyXProfile = (
  input: Omit<XProfileInput, 'cadenceMinutes' | 'revision'>,
): AcquisitionProfile =>
  xProfile({
    ...input,
    revision: 2,
    bootstrapLookbackMinutes: DAILY_X_ACCOUNT_BOOTSTRAP_LOOKBACK_MINUTES,
    cadenceMinutes: dailyXAccountCadence,
  });

const semanticProfile = (profileKey: string, priority: number): AcquisitionProfile => ({
  profileKey,
  revision: 1,
  adapterKind: 'X_SEMANTIC',
  lane: 'SEMANTIC',
  priority,
  cadenceMinutes: { NORMAL: 120, APPROACHING: 60, FINAL90: 30 },
  bootstrap: { lookbackMinutes: 360, maxItems: 10, maxContentJobs: 0 },
  saturationThreshold: 10,
  partitionMaxMembers: 1,
});

export const ACQUISITION_PROFILES: Readonly<Record<string, AcquisitionProfile>> = {
  // Revision 1 remains available for historical request replay.  The
  // manifest uses the revision 2 profiles below.
  'x-official-v1': xProfile({
    profileKey: 'x-official-v1',
    lane: 'OFFICIAL',
    priority: 10,
    cadenceMinutes: { NORMAL: 30, APPROACHING: 10, FINAL90: 3 },
  }),
  'x-club-v1': xProfile({
    profileKey: 'x-club-v1',
    lane: 'CLUB',
    priority: 30,
    cadenceMinutes: { NORMAL: 60, APPROACHING: 20, FINAL90: 10 },
  }),
  'x-reporter-v1': xProfile({
    profileKey: 'x-reporter-v1',
    lane: 'REPORTER',
    priority: 20,
    cadenceMinutes: { NORMAL: 60, APPROACHING: 20, FINAL90: 10 },
  }),
  'x-creator-v1': xProfile({
    profileKey: 'x-creator-v1',
    lane: 'CREATOR',
    priority: 50,
    cadenceMinutes: { NORMAL: 120, APPROACHING: 60, FINAL90: 30 },
  }),
  'x-longform-v1': xProfile({
    profileKey: 'x-longform-v1',
    lane: 'LONGFORM',
    priority: 60,
    cadenceMinutes: { NORMAL: 240, APPROACHING: 120, FINAL90: 60 },
  }),
  'x-official-v2': dailyXProfile({
    profileKey: 'x-official-v2',
    lane: 'OFFICIAL',
    priority: 10,
  }),
  'x-club-v2': dailyXProfile({
    profileKey: 'x-club-v2',
    lane: 'CLUB',
    priority: 30,
  }),
  'x-reporter-v2': dailyXProfile({
    profileKey: 'x-reporter-v2',
    lane: 'REPORTER',
    priority: 20,
  }),
  'x-creator-v2': dailyXProfile({
    profileKey: 'x-creator-v2',
    lane: 'CREATOR',
    priority: 50,
  }),
  'x-longform-v2': dailyXProfile({
    profileKey: 'x-longform-v2',
    lane: 'LONGFORM',
    priority: 60,
  }),
  'x-semantic-official-v1': semanticProfile('x-semantic-official-v1', 40),
  'x-semantic-availability-v1': semanticProfile('x-semantic-availability-v1', 40),
  'x-semantic-lineup-v1': semanticProfile('x-semantic-lineup-v1', 40),
  'x-semantic-longform-v1': semanticProfile('x-semantic-longform-v1', 40),
  'rss-news-v1': {
    profileKey: 'rss-news-v1',
    revision: 1,
    adapterKind: 'RSS_ATOM',
    lane: 'FEED',
    priority: 40,
    cadenceMinutes: { NORMAL: 60, APPROACHING: 30, FINAL90: 15 },
    bootstrap: { lookbackMinutes: 14 * 24 * 60, maxItems: 50, maxContentJobs: 20 },
  },
  'substack-public-v1': {
    profileKey: 'substack-public-v1',
    revision: 1,
    adapterKind: 'RSS_ATOM',
    lane: 'FEED',
    priority: 50,
    cadenceMinutes: { NORMAL: 60, APPROACHING: 30, FINAL90: 15 },
    bootstrap: { lookbackMinutes: 14 * 24 * 60, maxItems: 20, maxContentJobs: 20 },
  },
  'podcast-public-v1': {
    profileKey: 'podcast-public-v1',
    revision: 1,
    adapterKind: 'PODCAST_FEED',
    lane: 'PODCAST',
    priority: 60,
    cadenceMinutes: { NORMAL: 60, APPROACHING: 30, FINAL90: 30 },
    bootstrap: { lookbackMinutes: 14 * 24 * 60, maxItems: 3, maxContentJobs: 1 },
  },
  'youtube-caption-first-v1': {
    profileKey: 'youtube-caption-first-v1',
    revision: 1,
    adapterKind: 'YOUTUBE_CHANNEL',
    lane: 'YOUTUBE',
    priority: 50,
    cadenceMinutes: { NORMAL: 30, APPROACHING: 15, FINAL90: 10 },
    bootstrap: { lookbackMinutes: 14 * 24 * 60, maxItems: 15, maxContentJobs: 5 },
  },
};

export function getAcquisitionProfile(profileKey: string): AcquisitionProfile | null {
  return ACQUISITION_PROFILES[profileKey] ?? null;
}
