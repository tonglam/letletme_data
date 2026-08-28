import {
  parseStrictBooleanEnvValue,
  parseStrictIntegerEnvValue,
  parseStrictNumberEnvValue,
} from '../utils/config';

export type ContentRuntimeFlags = Readonly<{
  pipelineEnabled: boolean;
  acquisitionShadowMode: boolean;
  xScanEnabled: boolean;
  xBackstopEnabled: boolean;
  httpAcquisitionEnabled: boolean;
  podcastTranscriptEnabled: boolean;
  youtubeDiscoveryEnabled: boolean;
  youtubeNativeEnabled: boolean;
  youtubeGeneratedEnabled: boolean;
  realGrokEnabled: boolean;
  publicationEnabled: boolean;
  briefingPublicEnabled: boolean;
  grokConcurrency: number;
  httpConcurrency: number;
  httpHostConcurrency: number;
  hermesTranscriptConcurrency: number;
  hermesTranscriptUrl: string | null;
  hermesTranscriptTokenPresent: boolean;
  hermesTranscriptTimeoutMs: number;
  hermesTranscriptMaxOutputBytes: number;
  supadataTimeoutMs: number;
  supadataMaxOutputBytes: number;
  supadataJobPollIntervalMs: number;
  grokTimeoutMs: number;
  grokMaxOutputBytes: number;
  grokExpectedVersion: string;
  grokRunnerSocket: string;
  grokRunnerReleaseSha: string | null;
  httpTimeoutMs: number;
  httpMaxOutputBytes: number;
  dailyXCallLimit: number;
  final90XCallLimit: number;
  identityXCallLimit: number;
  /** Temporary multiplier for recurring X lane caps; tune from observed usage. */
  xLaneCapMultiplier: number;
  supadataDailyCreditLimit: number;
  hermesDailyAudioMinutes: number;
  supadataApiKeyPresent: boolean;
  youtubeDataApiKeyPresent: boolean;
  revalidationUrl: string | null;
  revalidationSecret: string | null;
  editorApiKeyHashes: readonly string[];
  publisherApiKeyHashes: readonly string[];
}>;

export function parseContentApiKeyHashes(
  value: string | undefined,
  name: string,
): readonly string[] {
  if (!value?.trim()) return [];
  const hashes = value.split(',').map((item) => item.trim().toLowerCase());
  if (hashes.some((item) => !/^[0-9a-f]{64}$/.test(item))) {
    throw new Error(`${name} must contain only comma-separated SHA-256 hex digests`);
  }
  return [...new Set(hashes)];
}

export function parseStrictBooleanEnv(
  value: string | undefined,
  fallback: boolean,
  name = 'boolean environment variable',
): boolean {
  return parseStrictBooleanEnvValue(value, fallback, name);
}

export function parseStrictIntegerEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  return parseStrictIntegerEnvValue(value, fallback, minimum, maximum, name);
}

export function parseStrictNumberEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  return parseStrictNumberEnvValue(value, fallback, minimum, maximum, name);
}

const booleanEnv = (name: string, fallback: boolean): boolean =>
  parseStrictBooleanEnv(process.env[name], fallback, name);

const integerEnv = (name: string, fallback: number, minimum: number, maximum: number): number =>
  parseStrictIntegerEnv(process.env[name], fallback, minimum, maximum, name);

const numberEnv = (name: string, fallback: number, minimum: number, maximum: number): number =>
  parseStrictNumberEnv(process.env[name], fallback, minimum, maximum, name);

function assertHttpUrlWithoutCredentials(value: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  }
}

export function getContentRuntimeFlags(): ContentRuntimeFlags {
  return {
    pipelineEnabled: booleanEnv('CONTENT_PIPELINE_ENABLED', false),
    acquisitionShadowMode: booleanEnv('CONTENT_ACQUISITION_SHADOW_MODE', false),
    xScanEnabled: booleanEnv('CONTENT_X_SCAN_ENABLED', false),
    xBackstopEnabled: booleanEnv('CONTENT_X_BACKSTOP_ENABLED', false),
    httpAcquisitionEnabled: booleanEnv('CONTENT_HTTP_ACQUISITION_ENABLED', false),
    podcastTranscriptEnabled: booleanEnv('CONTENT_PODCAST_TRANSCRIPT_ENABLED', false),
    youtubeDiscoveryEnabled: booleanEnv('CONTENT_YOUTUBE_DISCOVERY_ENABLED', false),
    youtubeNativeEnabled: booleanEnv('CONTENT_YOUTUBE_NATIVE_ENABLED', false),
    youtubeGeneratedEnabled: booleanEnv('CONTENT_YOUTUBE_GENERATED_ENABLED', false),
    realGrokEnabled: booleanEnv('CONTENT_REAL_GROK_ENABLED', false),
    publicationEnabled: booleanEnv('CONTENT_PUBLICATION_ENABLED', false),
    briefingPublicEnabled: booleanEnv('BRIEFING_PUBLIC_ENABLED', false),
    grokConcurrency: integerEnv('CONTENT_GROK_CONCURRENCY', 2, 1, 32),
    httpConcurrency: integerEnv('CONTENT_HTTP_CONCURRENCY', 4, 1, 32),
    httpHostConcurrency: integerEnv('CONTENT_HTTP_HOST_CONCURRENCY', 2, 1, 32),
    hermesTranscriptConcurrency: integerEnv('CONTENT_HERMES_TRANSCRIPT_CONCURRENCY', 1, 1, 32),
    hermesTranscriptUrl: process.env.HERMES_TRANSCRIPT_URL?.trim() || null,
    hermesTranscriptTokenPresent: Boolean(process.env.HERMES_TRANSCRIPT_TOKEN?.trim()),
    hermesTranscriptTimeoutMs: integerEnv(
      'CONTENT_HERMES_TRANSCRIPT_TIMEOUT_MS',
      2 * 60 * 60_000,
      1_000,
      2 * 60 * 60_000,
    ),
    hermesTranscriptMaxOutputBytes: integerEnv(
      'CONTENT_HERMES_TRANSCRIPT_MAX_OUTPUT_BYTES',
      16 * 1024 * 1024,
      1024,
      16 * 1024 * 1024,
    ),
    supadataTimeoutMs: integerEnv('CONTENT_SUPADATA_TIMEOUT_MS', 75_000, 1_000, 2 * 60 * 60_000),
    supadataMaxOutputBytes: integerEnv(
      'CONTENT_SUPADATA_MAX_OUTPUT_BYTES',
      16 * 1024 * 1024,
      1024,
      16 * 1024 * 1024,
    ),
    supadataJobPollIntervalMs: integerEnv(
      'CONTENT_SUPADATA_JOB_POLL_INTERVAL_MS',
      5_000,
      1_000,
      24 * 60 * 60_000,
    ),
    // The host runner's execution contract historically caps one Grok call
    // at four minutes; longer values need a separately validated rollout.
    grokTimeoutMs: integerEnv('CONTENT_GROK_TIMEOUT_MS', 240_000, 1_000, 240_000),
    grokMaxOutputBytes: integerEnv(
      'CONTENT_GROK_MAX_OUTPUT_BYTES',
      4 * 1024 * 1024,
      1024,
      4 * 1024 * 1024,
    ),
    grokExpectedVersion: process.env.CONTENT_GROK_EXPECTED_VERSION?.trim() || '1.0.5',
    grokRunnerSocket:
      process.env.CONTENT_GROK_RUNNER_SOCKET?.trim() || '/run/letletme-grok-runner/runner.sock',
    grokRunnerReleaseSha: process.env.CONTENT_GROK_RUNNER_RELEASE_SHA?.trim() || null,
    httpTimeoutMs: integerEnv('CONTENT_HTTP_TIMEOUT_MS', 40_000, 1_000, 2 * 60 * 60_000),
    httpMaxOutputBytes: integerEnv(
      'CONTENT_HTTP_MAX_OUTPUT_BYTES',
      8_388_608,
      1024,
      16 * 1024 * 1024,
    ),
    dailyXCallLimit: integerEnv('CONTENT_X_DAILY_CALL_LIMIT', 2_400, 0, 1_000_000),
    final90XCallLimit: integerEnv('CONTENT_X_FINAL90_CALL_LIMIT', 300, 0, 1_000_000),
    identityXCallLimit: integerEnv('CONTENT_X_IDENTITY_CALL_LIMIT', 100, 0, 1_000_000),
    xLaneCapMultiplier: numberEnv('CONTENT_X_LANE_CAP_MULTIPLIER', 1, 0.1, 10),
    supadataDailyCreditLimit: integerEnv('CONTENT_SUPADATA_DAILY_CREDIT_LIMIT', 0, 0, 1_000_000),
    hermesDailyAudioMinutes: integerEnv('CONTENT_HERMES_DAILY_AUDIO_MINUTES', 0, 0, 1_000_000),
    supadataApiKeyPresent: Boolean(process.env.SUPADATA_API_KEY?.trim()),
    youtubeDataApiKeyPresent: Boolean(process.env.YOUTUBE_DATA_API_KEY?.trim()),
    revalidationUrl: process.env.BRIEFING_REVALIDATE_URL?.trim() || null,
    revalidationSecret: process.env.BRIEFING_REVALIDATE_SECRET?.trim() || null,
    editorApiKeyHashes: parseContentApiKeyHashes(
      process.env.CONTENT_EDITOR_API_KEY_HASHES,
      'CONTENT_EDITOR_API_KEY_HASHES',
    ),
    publisherApiKeyHashes: parseContentApiKeyHashes(
      process.env.CONTENT_PUBLISHER_API_KEY_HASHES,
      'CONTENT_PUBLISHER_API_KEY_HASHES',
    ),
  };
}

export function assertContentRuntimeFlags(flags: ContentRuntimeFlags): void {
  for (const [name, value] of [
    ['CONTENT_X_DAILY_CALL_LIMIT', flags.dailyXCallLimit],
    ['CONTENT_X_FINAL90_CALL_LIMIT', flags.final90XCallLimit],
    ['CONTENT_X_IDENTITY_CALL_LIMIT', flags.identityXCallLimit],
    ['CONTENT_SUPADATA_DAILY_CREDIT_LIMIT', flags.supadataDailyCreditLimit],
    ['CONTENT_HERMES_DAILY_AUDIO_MINUTES', flags.hermesDailyAudioMinutes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
      throw new Error(`${name} must be a non-negative safe integer between 0 and 1000000`);
    }
  }
  if (flags.realGrokEnabled && !flags.pipelineEnabled) {
    throw new Error('CONTENT_REAL_GROK_ENABLED requires CONTENT_PIPELINE_ENABLED');
  }
  if (
    (flags.xScanEnabled ||
      flags.httpAcquisitionEnabled ||
      flags.podcastTranscriptEnabled ||
      flags.youtubeDiscoveryEnabled ||
      flags.youtubeNativeEnabled ||
      flags.youtubeGeneratedEnabled) &&
    !flags.pipelineEnabled
  ) {
    throw new Error('Briefing acquisition adapters require CONTENT_PIPELINE_ENABLED');
  }
  if (flags.realGrokEnabled && !flags.xScanEnabled) {
    throw new Error('CONTENT_REAL_GROK_ENABLED requires CONTENT_X_SCAN_ENABLED');
  }
  if (flags.xBackstopEnabled && (!flags.xScanEnabled || !flags.realGrokEnabled)) {
    throw new Error('CONTENT_X_BACKSTOP_ENABLED requires real X scanning');
  }
  if (flags.youtubeDiscoveryEnabled && !flags.httpAcquisitionEnabled) {
    throw new Error('CONTENT_YOUTUBE_DISCOVERY_ENABLED requires CONTENT_HTTP_ACQUISITION_ENABLED');
  }
  if (
    flags.podcastTranscriptEnabled &&
    (!flags.httpAcquisitionEnabled ||
      !flags.hermesTranscriptUrl ||
      !flags.hermesTranscriptTokenPresent ||
      flags.hermesDailyAudioMinutes < 1)
  ) {
    throw new Error(
      'CONTENT_PODCAST_TRANSCRIPT_ENABLED requires HTTP acquisition, Hermes URL/token and a positive audio-minute limit',
    );
  }
  if (flags.podcastTranscriptEnabled && flags.hermesTranscriptUrl) {
    assertHttpUrlWithoutCredentials(flags.hermesTranscriptUrl, 'HERMES_TRANSCRIPT_URL');
  }
  if (
    flags.youtubeNativeEnabled &&
    (!flags.youtubeDiscoveryEnabled ||
      !flags.youtubeDataApiKeyPresent ||
      !flags.supadataApiKeyPresent ||
      flags.supadataDailyCreditLimit < 1)
  ) {
    throw new Error(
      'CONTENT_YOUTUBE_NATIVE_ENABLED requires discovery, YOUTUBE_DATA_API_KEY, SUPADATA_API_KEY and a positive credit limit',
    );
  }
  if (flags.youtubeGeneratedEnabled && !flags.youtubeNativeEnabled) {
    throw new Error('CONTENT_YOUTUBE_GENERATED_ENABLED requires CONTENT_YOUTUBE_NATIVE_ENABLED');
  }
  if (flags.publicationEnabled && !flags.pipelineEnabled) {
    throw new Error('CONTENT_PUBLICATION_ENABLED requires CONTENT_PIPELINE_ENABLED');
  }
  if (flags.revalidationUrl) {
    assertHttpUrlWithoutCredentials(flags.revalidationUrl, 'BRIEFING_REVALIDATE_URL');
  }
  if (
    flags.publicationEnabled &&
    (!flags.revalidationUrl || !flags.revalidationSecret || flags.revalidationSecret.length < 32)
  ) {
    throw new Error(
      'CONTENT_PUBLICATION_ENABLED requires BRIEFING_REVALIDATE_URL and a secret of at least 32 characters',
    );
  }
  if (flags.publicationEnabled && flags.publisherApiKeyHashes.length === 0) {
    throw new Error('CONTENT_PUBLICATION_ENABLED requires CONTENT_PUBLISHER_API_KEY_HASHES');
  }
  if (flags.briefingPublicEnabled && !flags.publicationEnabled) {
    throw new Error('BRIEFING_PUBLIC_ENABLED requires CONTENT_PUBLICATION_ENABLED');
  }
  for (const [name, value] of [
    ['CONTENT_GROK_CONCURRENCY', flags.grokConcurrency],
    ['CONTENT_HTTP_CONCURRENCY', flags.httpConcurrency],
    ['CONTENT_HTTP_HOST_CONCURRENCY', flags.httpHostConcurrency],
    ['CONTENT_HERMES_TRANSCRIPT_CONCURRENCY', flags.hermesTranscriptConcurrency],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
      throw new Error(`${name} must be a safe integer between 1 and 32`);
    }
  }
  if (flags.grokConcurrency > 2) {
    throw new Error('CONTENT_GROK_CONCURRENCY above 2 requires a separately validated rollout');
  }
  if (flags.grokRunnerSocket.length === 0 || !flags.grokRunnerSocket.startsWith('/')) {
    throw new Error('CONTENT_GROK_RUNNER_SOCKET must be an absolute Unix socket path');
  }
  if (
    flags.grokRunnerReleaseSha !== null &&
    flags.grokRunnerReleaseSha !== 'unknown' &&
    !/^[0-9a-f]{7,128}$/i.test(flags.grokRunnerReleaseSha)
  ) {
    throw new Error('CONTENT_GROK_RUNNER_RELEASE_SHA must be a release SHA or unknown');
  }
  for (const [name, value] of [
    ['CONTENT_HERMES_TRANSCRIPT_TIMEOUT_MS', flags.hermesTranscriptTimeoutMs],
    ['CONTENT_SUPADATA_TIMEOUT_MS', flags.supadataTimeoutMs],
    ['CONTENT_HTTP_TIMEOUT_MS', flags.httpTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 2 * 60 * 60_000) {
      throw new Error(`${name} must be a safe integer between 1000 and 7200000`);
    }
  }
  if (
    !Number.isSafeInteger(flags.grokTimeoutMs) ||
    flags.grokTimeoutMs < 1_000 ||
    flags.grokTimeoutMs > 240_000
  ) {
    throw new Error('CONTENT_GROK_TIMEOUT_MS must be a safe integer between 1000 and 240000');
  }
  for (const [name, value] of [
    ['CONTENT_SUPADATA_JOB_POLL_INTERVAL_MS', flags.supadataJobPollIntervalMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 24 * 60 * 60_000) {
      throw new Error(`${name} must be a safe integer between 1000 and 86400000`);
    }
  }
  for (const [name, value] of [
    ['CONTENT_HERMES_TRANSCRIPT_MAX_OUTPUT_BYTES', flags.hermesTranscriptMaxOutputBytes],
    ['CONTENT_SUPADATA_MAX_OUTPUT_BYTES', flags.supadataMaxOutputBytes],
    ['CONTENT_HTTP_MAX_OUTPUT_BYTES', flags.httpMaxOutputBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1024 || value > 16 * 1024 * 1024) {
      throw new Error(`${name} must be a safe integer between 1024 and 16777216`);
    }
  }
  if (
    !Number.isSafeInteger(flags.grokMaxOutputBytes) ||
    flags.grokMaxOutputBytes < 1024 ||
    flags.grokMaxOutputBytes > 4 * 1024 * 1024
  ) {
    throw new Error(
      'CONTENT_GROK_MAX_OUTPUT_BYTES must be a safe integer between 1024 and 4194304',
    );
  }
  if (
    !Number.isFinite(flags.xLaneCapMultiplier) ||
    flags.xLaneCapMultiplier < 0.1 ||
    flags.xLaneCapMultiplier > 10
  ) {
    throw new Error('CONTENT_X_LANE_CAP_MULTIPLIER must be between 0.1 and 10');
  }
  if (flags.httpHostConcurrency > flags.httpConcurrency) {
    throw new Error('CONTENT_HTTP_HOST_CONCURRENCY cannot exceed CONTENT_HTTP_CONCURRENCY');
  }
}
