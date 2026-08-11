import { createHash } from 'node:crypto';

import type { DataPublicationDataset, DataPublicationState } from '../cache/data-publication';

export interface ActivePublicationIdentity {
  readonly dataset: DataPublicationDataset;
  readonly seasonCode: string;
  readonly eventId: number | null;
  readonly revision: number;
  readonly publicationId: string;
  readonly state: DataPublicationState;
}

export interface RetiredDataPublicationItem {
  readonly name: string;
  readonly key: string;
  readonly type: 'string';
  readonly count: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RetiredDataPublicationManifest extends ActivePublicationIdentity {
  readonly sourceCheckedAt: string;
  readonly publishedAt: string;
  readonly items: readonly RetiredDataPublicationItem[];
}

const CORE_ITEM_NAMES = ['events', 'teams', 'players', 'phases', 'fixtures', 'currentEventId'];
const LIVE_ITEM_NAMES = ['eventLives', 'fixtures', 'liveFixtures', 'liveBonus'];
const COMMON_FIELDS = [
  'schemaVersion',
  'planVersion',
  'dataset',
  'seasonCode',
  'eventId',
  'revision',
  'publicationId',
  'sourceCheckedAt',
  'publishedAt',
  'items',
] as const;
const ITEM_FIELDS = ['name', 'key', 'type', 'count', 'bytes', 'sha256'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  );
}

function itemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return value === null || value === undefined ? 0 : 1;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function expectedItemNames(dataset: DataPublicationDataset): readonly string[] {
  return dataset === 'fpl:core' ? CORE_ITEM_NAMES : LIVE_ITEM_NAMES;
}

function retiredActiveKey(identity: ActivePublicationIdentity): RegExp {
  const suffix =
    identity.dataset === 'fpl:core'
      ? `fpl:core:${identity.seasonCode}:active`
      : `fpl:live:${identity.seasonCode}:${identity.eventId}:active`;
  return new RegExp(`^llm:v[0-9]+:data:${suffix}$`);
}

export function isRetiredDataKey(key: string): boolean {
  return (
    /^llm:v[0-9]+:data:fpl:core:\d{4}:(?:active|\d+:[a-z][a-zA-Z0-9]*)$/.test(key) ||
    /^llm:v[0-9]+:data:fpl:live:\d{4}:\d+:(?:active|\d+:[a-z][a-zA-Z0-9]*)$/.test(key)
  );
}

export function parseRetiredDataActiveKeyScope(key: string): {
  readonly dataset: DataPublicationDataset;
  readonly seasonCode: string;
  readonly eventId: number | null;
} | null {
  const core = /^llm:v[0-9]+:data:fpl:core:(\d{4}):active$/.exec(key);
  if (core) return { dataset: 'fpl:core', seasonCode: core[1], eventId: null };
  const live = /^llm:v[0-9]+:data:fpl:live:(\d{4}):(\d+):active$/.exec(key);
  if (!live) return null;
  const eventId = Number(live[2]);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
  return { dataset: 'fpl:live', seasonCode: live[1], eventId };
}

export function retiredDataActivePattern(identity: ActivePublicationIdentity): string {
  return identity.dataset === 'fpl:core'
    ? `llm:v*:data:fpl:core:${identity.seasonCode}:active`
    : `llm:v*:data:fpl:live:${identity.seasonCode}:${identity.eventId}:active`;
}

export function parseRetiredDataPublicationManifest(
  activeKey: string,
  rawManifest: string | null,
  expected: ActivePublicationIdentity,
): RetiredDataPublicationManifest {
  if (!retiredActiveKey(expected).test(activeKey)) {
    throw new Error(`Retired Data active key does not match its database scope: ${activeKey}`);
  }
  if (!rawManifest) throw new Error(`Retired Data active key has no manifest: ${activeKey}`);

  let value: unknown;
  try {
    value = JSON.parse(rawManifest) as unknown;
  } catch {
    throw new Error(`Retired Data active key has invalid JSON: ${activeKey}`);
  }
  if (!isRecord(value)) {
    throw new Error(`Retired Data active key is not a manifest object: ${activeKey}`);
  }

  const fields = expected.dataset === 'fpl:live' ? [...COMMON_FIELDS, 'state'] : COMMON_FIELDS;
  if (!hasExactFields(value, fields)) {
    throw new Error(`Retired Data manifest has an unexpected field set: ${activeKey}`);
  }
  if (
    typeof value.schemaVersion !== 'string' ||
    value.schemaVersion.length === 0 ||
    typeof value.planVersion !== 'string' ||
    value.planVersion.length === 0 ||
    value.dataset !== expected.dataset ||
    value.seasonCode !== expected.seasonCode ||
    value.eventId !== expected.eventId ||
    value.revision !== expected.revision ||
    value.publicationId !== expected.publicationId ||
    typeof value.sourceCheckedAt !== 'string' ||
    !Number.isFinite(new Date(value.sourceCheckedAt).getTime()) ||
    typeof value.publishedAt !== 'string' ||
    !Number.isFinite(new Date(value.publishedAt).getTime()) ||
    !Array.isArray(value.items)
  ) {
    throw new Error(`Retired Data manifest does not match its database publication: ${activeKey}`);
  }
  if (expected.dataset === 'fpl:live' && value.state !== expected.state) {
    throw new Error(`Retired live manifest state does not match PostgreSQL: ${activeKey}`);
  }

  const activePrefix = activeKey.slice(0, -':active'.length);
  const expectedNames = [...expectedItemNames(expected.dataset)].sort();
  const names = new Set<string>();
  const items: RetiredDataPublicationItem[] = [];
  for (const item of value.items) {
    if (!isRecord(item) || !hasExactFields(item, ITEM_FIELDS)) {
      throw new Error(`Retired Data manifest has an invalid item: ${activeKey}`);
    }
    const name = item.name;
    if (
      typeof name !== 'string' ||
      !/^[a-z][a-zA-Z0-9]*$/.test(name) ||
      names.has(name) ||
      item.key !== `${activePrefix}:${expected.revision}:${name}` ||
      item.type !== 'string' ||
      typeof item.count !== 'number' ||
      !Number.isInteger(item.count) ||
      item.count < 0 ||
      typeof item.bytes !== 'number' ||
      !Number.isInteger(item.bytes) ||
      item.bytes < 0 ||
      typeof item.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    ) {
      throw new Error(`Retired Data manifest item contract is invalid: ${activeKey}`);
    }
    names.add(name);
    items.push({
      name,
      key: item.key,
      type: 'string',
      count: item.count,
      bytes: item.bytes,
      sha256: item.sha256,
    });
  }
  const actualNames = [...names].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(`Retired Data manifest item set is incomplete: ${activeKey}`);
  }

  return {
    ...expected,
    sourceCheckedAt: value.sourceCheckedAt,
    publishedAt: value.publishedAt,
    items,
  };
}

export function decodeRetiredDataPublicationItems(
  manifest: RetiredDataPublicationManifest,
  payloads: readonly (string | null)[],
): Readonly<Record<string, unknown>> {
  if (payloads.length !== manifest.items.length) {
    throw new Error('Retired Data publication payload count does not match its manifest');
  }

  const decoded: Record<string, unknown> = {};
  manifest.items.forEach((item, index) => {
    const payload = payloads[index];
    if (
      payload === null ||
      Buffer.byteLength(payload, 'utf8') !== item.bytes ||
      sha256(payload) !== item.sha256
    ) {
      throw new Error(`Retired Data publication payload failed integrity: ${item.name}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(payload) as unknown;
    } catch {
      throw new Error(`Retired Data publication payload is invalid JSON: ${item.name}`);
    }
    if (itemCount(value) !== item.count) {
      throw new Error(`Retired Data publication payload count is invalid: ${item.name}`);
    }
    decoded[item.name] = value;
  });
  return decoded;
}
