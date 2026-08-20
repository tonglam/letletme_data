export type ContentRuntimeFlags = Readonly<{
  pipelineEnabled: boolean;
  realGrokEnabled: boolean;
  publicationEnabled: boolean;
  briefingPublicEnabled: boolean;
  grokConcurrency: number;
  pollMaxXCalls: number;
  dailyXCallBudget: number;
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

export function getContentRuntimeFlags(): ContentRuntimeFlags {
  return {
    pipelineEnabled: booleanEnv(process.env.CONTENT_PIPELINE_ENABLED, false),
    realGrokEnabled: booleanEnv(process.env.CONTENT_REAL_GROK_ENABLED, false),
    publicationEnabled: booleanEnv(process.env.CONTENT_PUBLICATION_ENABLED, false),
    briefingPublicEnabled: booleanEnv(process.env.BRIEFING_PUBLIC_ENABLED, false),
    grokConcurrency: Math.max(1, Number(process.env.CONTENT_GROK_CONCURRENCY ?? 1)),
    pollMaxXCalls: Math.max(1, Number(process.env.CONTENT_POLL_MAX_X_CALLS ?? 2)),
    dailyXCallBudget: Math.max(1, Number(process.env.CONTENT_DAILY_X_CALL_BUDGET ?? 24)),
    revalidationUrl: process.env.BRIEFING_REVALIDATE_URL?.trim() || null,
    revalidationSecret: process.env.BRIEFING_REVALIDATE_SECRET?.trim() || null,
    editorApiKeyHashes: apiKeyHashes(process.env.CONTENT_EDITOR_API_KEY_HASHES),
    publisherApiKeyHashes: apiKeyHashes(process.env.CONTENT_PUBLISHER_API_KEY_HASHES),
  };
}

export function assertContentRuntimeFlags(flags: ContentRuntimeFlags): void {
  if (flags.realGrokEnabled && !flags.pipelineEnabled) {
    throw new Error('CONTENT_REAL_GROK_ENABLED requires CONTENT_PIPELINE_ENABLED');
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
  if (!Number.isSafeInteger(flags.pollMaxXCalls) || flags.pollMaxXCalls < 1) {
    throw new Error('CONTENT_POLL_MAX_X_CALLS must be a positive integer');
  }
  if (
    !Number.isSafeInteger(flags.dailyXCallBudget) ||
    flags.dailyXCallBudget < flags.pollMaxXCalls
  ) {
    throw new Error(
      'CONTENT_DAILY_X_CALL_BUDGET must be an integer at least CONTENT_POLL_MAX_X_CALLS',
    );
  }
}
