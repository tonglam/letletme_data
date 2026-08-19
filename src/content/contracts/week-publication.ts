import { createHash } from 'node:crypto';

export const WEEK_PUBLICATION_SCHEMA_VERSION = 1 as const;
export const WEEK_LOCALES = ['en', 'zh-CN'] as const;
export type WeekLocale = (typeof WEEK_LOCALES)[number];
export type BriefingState = 'READY' | 'EMPTY' | 'STALE' | 'OFFSEASON' | 'UNAVAILABLE' | 'REMOVED';

export type WeekEvent = {
  readonly seasonCode: string;
  readonly eventId: number;
  readonly name: string;
  readonly deadlineTime: string;
};

export type WeekStoryCard = {
  readonly id: string;
  readonly slug: string;
  readonly storyRevision: number;
  readonly title: string;
  readonly summary: string;
  readonly sourceName?: string | null;
  readonly sourceUrl?: string | null;
  readonly sourceCheckedAt?: string | null;
  readonly expiresAt?: string | null;
};

export type WeekSection = {
  readonly key: string;
  readonly title: string;
  readonly items: readonly WeekStoryCard[];
};

export type WeekPublicationEnvelope = {
  readonly schemaVersion: typeof WEEK_PUBLICATION_SCHEMA_VERSION;
  readonly scopeKind: 'SURFACE';
  readonly scopeKey: 'week';
  readonly revision: number;
  readonly publicationId: string;
  readonly state: BriefingState;
  readonly locale: WeekLocale;
  readonly publishedAt: string;
  readonly sourceCheckedAt: string;
  readonly validUntil: string | null;
  readonly event: WeekEvent | null;
  readonly featured: readonly WeekStoryCard[];
  readonly sections: readonly WeekSection[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

const hasInteger = (value: unknown): value is number => Number.isSafeInteger(value);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertStoryCard(value: unknown, path: string): asserts value is WeekStoryCard {
  assert(isRecord(value), `${path} must be an object`);
  assert(typeof value.id === 'string' && value.id.length > 0, `${path}.id is required`);
  assert(typeof value.slug === 'string' && value.slug.length > 0, `${path}.slug is required`);
  assert(
    hasInteger(value.storyRevision) && value.storyRevision > 0,
    `${path}.storyRevision is invalid`,
  );
  assert(
    typeof value.title === 'string' && value.title.trim().length > 0,
    `${path}.title is required`,
  );
  assert(
    typeof value.summary === 'string' && value.summary.trim().length > 0,
    `${path}.summary is required`,
  );
  for (const field of ['sourceName', 'sourceUrl', 'sourceCheckedAt', 'expiresAt'] as const) {
    if (value[field] !== undefined && value[field] !== null) {
      assert(typeof value[field] === 'string', `${path}.${field} must be a string or null`);
    }
  }
  if (typeof value.sourceUrl === 'string') {
    try {
      const protocol = new URL(value.sourceUrl).protocol;
      assert(protocol === 'http:' || protocol === 'https:', `${path}.sourceUrl must be http(s)`);
    } catch {
      throw new Error(`${path}.sourceUrl is invalid`);
    }
  }
  if (value.sourceCheckedAt)
    assert(hasIsoDate(value.sourceCheckedAt), `${path}.sourceCheckedAt is invalid`);
  if (value.expiresAt) assert(hasIsoDate(value.expiresAt), `${path}.expiresAt is invalid`);
}

export function assertWeekPublication(value: unknown): asserts value is WeekPublicationEnvelope {
  assert(isRecord(value), 'Week publication must be an object');
  assert(
    value.schemaVersion === WEEK_PUBLICATION_SCHEMA_VERSION,
    'Unsupported Week schema version',
  );
  assert(value.scopeKind === 'SURFACE' && value.scopeKey === 'week', 'Invalid Week scope');
  assert(hasInteger(value.revision) && value.revision > 0, 'Invalid Week revision');
  assert(
    typeof value.publicationId === 'string' && UUID_RE.test(value.publicationId),
    'Invalid publication ID',
  );
  assert(
    value.state === 'READY' ||
      value.state === 'EMPTY' ||
      value.state === 'STALE' ||
      value.state === 'OFFSEASON' ||
      value.state === 'UNAVAILABLE' ||
      value.state === 'REMOVED',
    'Invalid Week state',
  );
  assert(value.locale === 'en' || value.locale === 'zh-CN', 'Invalid Week locale');
  assert(hasIsoDate(value.publishedAt), 'Invalid publishedAt');
  assert(hasIsoDate(value.sourceCheckedAt), 'Invalid sourceCheckedAt');
  assert(value.validUntil === null || hasIsoDate(value.validUntil), 'Invalid validUntil');
  assert(value.event === null || isRecord(value.event), 'Invalid event');
  if (value.event) {
    assert(
      typeof value.event.seasonCode === 'string' && /^\d{4}$/.test(value.event.seasonCode),
      'Invalid season code',
    );
    assert(hasInteger(value.event.eventId) && value.event.eventId > 0, 'Invalid event ID');
    assert(
      typeof value.event.name === 'string' && value.event.name.length > 0,
      'Invalid event name',
    );
    assert(hasIsoDate(value.event.deadlineTime), 'Invalid deadline time');
    if (value.validUntil)
      assert(
        Date.parse(value.validUntil) <= Date.parse(value.event.deadlineTime),
        'validUntil exceeds deadline',
      );
  }
  assert(Array.isArray(value.featured), 'featured must be an array');
  value.featured.forEach((item, index) => assertStoryCard(item, `featured[${index}]`));
  assert(Array.isArray(value.sections), 'sections must be an array');
  value.sections.forEach((section, sectionIndex) => {
    assert(isRecord(section), `sections[${sectionIndex}] must be an object`);
    assert(
      typeof section.key === 'string' && section.key.length > 0,
      `sections[${sectionIndex}].key is required`,
    );
    assert(
      typeof section.title === 'string' && section.title.length > 0,
      `sections[${sectionIndex}].title is required`,
    );
    assert(Array.isArray(section.items), `sections[${sectionIndex}].items must be an array`);
    section.items.forEach((item, itemIndex) =>
      assertStoryCard(item, `sections[${sectionIndex}].items[${itemIndex}]`),
    );
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function serializeWeekPublication(value: WeekPublicationEnvelope): string {
  assertWeekPublication(value);
  return JSON.stringify(canonicalize(value));
}

export function weekPublicationSha256(value: WeekPublicationEnvelope): string {
  return createHash('sha256').update(serializeWeekPublication(value), 'utf8').digest('hex');
}

export function weekPublicationBytes(value: WeekPublicationEnvelope): number {
  return Buffer.byteLength(serializeWeekPublication(value), 'utf8');
}

export function validateWeekLocalePair(
  english: WeekPublicationEnvelope,
  chinese: WeekPublicationEnvelope,
): void {
  assertWeekPublication(english);
  assertWeekPublication(chinese);
  assert(
    english.locale === 'en' && chinese.locale === 'zh-CN',
    'Week locale pair must be en and zh-CN',
  );
  assert(english.revision === chinese.revision, 'Week locales must share a revision');
  assert(english.publicationId === chinese.publicationId, 'Week locales must share a publication');
  assert(english.state === chinese.state, 'Week locales must share state');
  assert(
    JSON.stringify(english.event) === JSON.stringify(chinese.event),
    'Week locales must share event',
  );
  assert(english.validUntil === chinese.validUntil, 'Week locales must share validUntil');
  const ids = (value: WeekPublicationEnvelope): string[] => [
    ...value.featured.map((item) => `featured:${item.id}:${item.storyRevision}`),
    ...value.sections.flatMap((section) =>
      section.items.map((item) => `${section.key}:${item.id}:${item.storyRevision}`),
    ),
  ];
  assert(
    JSON.stringify(ids(english)) === JSON.stringify(ids(chinese)),
    'Week locales must share story order',
  );
  const storyKeys = (value: WeekPublicationEnvelope): string[] => [
    ...value.featured.map((item) => `${item.id}:${item.storyRevision}`),
    ...value.sections.flatMap((section) =>
      section.items.map((item) => `${item.id}:${item.storyRevision}`),
    ),
  ];
  const seen = new Set<string>();
  for (const key of storyKeys(english)) {
    assert(!seen.has(key), `Week publication contains duplicate story ${key}`);
    seen.add(key);
  }
}

export function isWeekPublicationSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}
