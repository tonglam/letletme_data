export type ContentRuntimeFlags = Readonly<{
  pipelineEnabled: boolean;
  acquisitionShadowMode: boolean;
  xScanEnabled: boolean;
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
  supadataDailyCreditLimit: number;
  hermesDailyAudioMinutes: number;
  supadataApiKeyPresent: boolean;
  youtubeDataApiKeyPresent: boolean;
  revalidationUrl: string | null;
  revalidationSecret: string | null;
  editorApiKeyHashes: readonly string[];
  publisherApiKeyHashes: readonly string[];
}>;

const apiKeyHashes = (value: string | undefined): readonly string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[0-9a-f]{64}$/.test(item));

const booleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

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
    pipelineEnabled: booleanEnv(process.env.CONTENT_PIPELINE_ENABLED, false),
    acquisitionShadowMode: booleanEnv(process.env.CONTENT_ACQUISITION_SHADOW_MODE, false),
    xScanEnabled: booleanEnv(process.env.CONTENT_X_SCAN_ENABLED, false),
    httpAcquisitionEnabled: booleanEnv(process.env.CONTENT_HTTP_ACQUISITION_ENABLED, false),
    podcastTranscriptEnabled: booleanEnv(process.env.CONTENT_PODCAST_TRANSCRIPT_ENABLED, false),
    youtubeDiscoveryEnabled: booleanEnv(process.env.CONTENT_YOUTUBE_DISCOVERY_ENABLED, false),
    youtubeNativeEnabled: booleanEnv(process.env.CONTENT_YOUTUBE_NATIVE_ENABLED, false),
    youtubeGeneratedEnabled: booleanEnv(process.env.CONTENT_YOUTUBE_GENERATED_ENABLED, false),
    realGrokEnabled: booleanEnv(process.env.CONTENT_REAL_GROK_ENABLED, false),
    publicationEnabled: booleanEnv(process.env.CONTENT_PUBLICATION_ENABLED, false),
    briefingPublicEnabled: booleanEnv(process.env.BRIEFING_PUBLIC_ENABLED, false),
    grokConcurrency: Math.max(1, Number(process.env.CONTENT_GROK_CONCURRENCY ?? 2)),
    httpConcurrency: Math.max(1, Number(process.env.CONTENT_HTTP_CONCURRENCY ?? 4)),
    httpHostConcurrency: Math.max(1, Number(process.env.CONTENT_HTTP_HOST_CONCURRENCY ?? 2)),
    hermesTranscriptConcurrency: Math.max(
      1,
      Number(process.env.CONTENT_HERMES_TRANSCRIPT_CONCURRENCY ?? 1),
    ),
    hermesTranscriptUrl: process.env.HERMES_TRANSCRIPT_URL?.trim() || null,
    hermesTranscriptTokenPresent: Boolean(process.env.HERMES_TRANSCRIPT_TOKEN?.trim()),
    hermesTranscriptTimeoutMs: Math.max(
      1,
      Number(process.env.CONTENT_HERMES_TRANSCRIPT_TIMEOUT_MS ?? 2 * 60 * 60_000),
    ),
    hermesTranscriptMaxOutputBytes: Math.max(
      1,
      Number(process.env.CONTENT_HERMES_TRANSCRIPT_MAX_OUTPUT_BYTES ?? 16 * 1024 * 1024),
    ),
    supadataTimeoutMs: Math.max(1, Number(process.env.CONTENT_SUPADATA_TIMEOUT_MS ?? 75_000)),
    supadataMaxOutputBytes: Math.max(
      1,
      Number(process.env.CONTENT_SUPADATA_MAX_OUTPUT_BYTES ?? 16 * 1024 * 1024),
    ),
    supadataJobPollIntervalMs: Math.max(
      1_000,
      Number(process.env.CONTENT_SUPADATA_JOB_POLL_INTERVAL_MS ?? 5_000),
    ),
    grokTimeoutMs: Math.min(
      240_000,
      Math.max(1, Number(process.env.CONTENT_GROK_TIMEOUT_MS ?? 240_000)),
    ),
    grokMaxOutputBytes: Math.min(
      4_194_304,
      Math.max(1, Number(process.env.CONTENT_GROK_MAX_OUTPUT_BYTES ?? 4_194_304)),
    ),
    grokExpectedVersion: process.env.CONTENT_GROK_EXPECTED_VERSION?.trim() || '1.0.5',
    grokRunnerSocket:
      process.env.CONTENT_GROK_RUNNER_SOCKET?.trim() || '/run/letletme-grok-runner/runner.sock',
    grokRunnerReleaseSha: process.env.CONTENT_GROK_RUNNER_RELEASE_SHA?.trim() || null,
    httpTimeoutMs: Math.max(1, Number(process.env.CONTENT_HTTP_TIMEOUT_MS ?? 40_000)),
    httpMaxOutputBytes: Math.max(1, Number(process.env.CONTENT_HTTP_MAX_OUTPUT_BYTES ?? 8_388_608)),
    dailyXCallLimit: Math.max(0, Number(process.env.CONTENT_X_DAILY_CALL_LIMIT ?? 2_400)),
    final90XCallLimit: Math.max(0, Number(process.env.CONTENT_X_FINAL90_CALL_LIMIT ?? 300)),
    identityXCallLimit: Math.max(0, Number(process.env.CONTENT_X_IDENTITY_CALL_LIMIT ?? 100)),
    supadataDailyCreditLimit: Math.max(
      0,
      Number(process.env.CONTENT_SUPADATA_DAILY_CREDIT_LIMIT ?? 0),
    ),
    hermesDailyAudioMinutes: Math.max(
      0,
      Number(process.env.CONTENT_HERMES_DAILY_AUDIO_MINUTES ?? 0),
    ),
    supadataApiKeyPresent: Boolean(process.env.SUPADATA_API_KEY?.trim()),
    youtubeDataApiKeyPresent: Boolean(process.env.YOUTUBE_DATA_API_KEY?.trim()),
    revalidationUrl: process.env.BRIEFING_REVALIDATE_URL?.trim() || null,
    revalidationSecret: process.env.BRIEFING_REVALIDATE_SECRET?.trim() || null,
    editorApiKeyHashes: apiKeyHashes(process.env.CONTENT_EDITOR_API_KEY_HASHES),
    publisherApiKeyHashes: apiKeyHashes(process.env.CONTENT_PUBLISHER_API_KEY_HASHES),
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
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
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
  if (flags.briefingPublicEnabled && !flags.publicationEnabled) {
    throw new Error('BRIEFING_PUBLIC_ENABLED requires CONTENT_PUBLICATION_ENABLED');
  }
  if (!Number.isSafeInteger(flags.grokConcurrency) || flags.grokConcurrency < 1) {
    throw new Error('CONTENT_GROK_CONCURRENCY must be a positive integer');
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
    ['CONTENT_HTTP_CONCURRENCY', flags.httpConcurrency],
    ['CONTENT_HTTP_HOST_CONCURRENCY', flags.httpHostConcurrency],
    ['CONTENT_HERMES_TRANSCRIPT_CONCURRENCY', flags.hermesTranscriptConcurrency],
    ['CONTENT_HERMES_TRANSCRIPT_TIMEOUT_MS', flags.hermesTranscriptTimeoutMs],
    ['CONTENT_HERMES_TRANSCRIPT_MAX_OUTPUT_BYTES', flags.hermesTranscriptMaxOutputBytes],
    ['CONTENT_SUPADATA_TIMEOUT_MS', flags.supadataTimeoutMs],
    ['CONTENT_SUPADATA_MAX_OUTPUT_BYTES', flags.supadataMaxOutputBytes],
    ['CONTENT_SUPADATA_JOB_POLL_INTERVAL_MS', flags.supadataJobPollIntervalMs],
    ['CONTENT_GROK_TIMEOUT_MS', flags.grokTimeoutMs],
    ['CONTENT_GROK_MAX_OUTPUT_BYTES', flags.grokMaxOutputBytes],
    ['CONTENT_HTTP_TIMEOUT_MS', flags.httpTimeoutMs],
    ['CONTENT_HTTP_MAX_OUTPUT_BYTES', flags.httpMaxOutputBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (flags.httpHostConcurrency > flags.httpConcurrency) {
    throw new Error('CONTENT_HTTP_HOST_CONCURRENCY cannot exceed CONTENT_HTTP_CONCURRENCY');
  }
}
