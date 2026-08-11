import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  buildCoordinationMigrationPairs,
  canonicalCoordinationKey,
} from '../../scripts/migrate-retired-redis-state';
import {
  decodeRetiredDataPublicationItems,
  isRetiredDataKey,
  parseRetiredDataActiveKeyScope,
  parseRetiredDataPublicationManifest,
  retiredDataActivePattern,
  type ActivePublicationIdentity,
} from '../../scripts/retired-data-publication';

const identity: ActivePublicationIdentity = {
  dataset: 'fpl:live',
  seasonCode: '2627',
  eventId: 3,
  revision: 41,
  publicationId: '11111111-1111-4111-8111-111111111111',
  state: 'live',
};

const payloadValues = {
  eventLives: [{ eventId: 3, elementId: 1, totalPoints: 2 }],
  fixtures: [{ id: 12, event: 3 }],
  liveFixtures: { '1': [{ fixtureId: 12 }] },
  liveBonus: { '1': { '12': 3 } },
} as const;

function payload(value: unknown): string {
  return JSON.stringify(value);
}

function item(name: keyof typeof payloadValues) {
  const value = payload(payloadValues[name]);
  return {
    name,
    key: `llm:v3:data:fpl:live:2627:3:41:${name}`,
    type: 'string',
    count: Array.isArray(payloadValues[name])
      ? payloadValues[name].length
      : Object.keys(payloadValues[name]).length,
    bytes: Buffer.byteLength(value, 'utf8'),
    sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
  };
}

function retiredManifest(): string {
  return JSON.stringify({
    schemaVersion: 'v3',
    planVersion: '3.2.5',
    dataset: 'fpl:live',
    seasonCode: '2627',
    eventId: 3,
    revision: 41,
    publicationId: identity.publicationId,
    sourceCheckedAt: '2026-08-10T23:00:00.000Z',
    publishedAt: '2026-08-10T23:00:01.000Z',
    state: 'live',
    items: [item('eventLives'), item('fixtures'), item('liveFixtures'), item('liveBonus')],
  });
}

describe('one-time Redis state transition', () => {
  test('strictly validates and decodes an active live publication before republishing it', () => {
    const activeKey = 'llm:v3:data:fpl:live:2627:3:active';
    const manifest = parseRetiredDataPublicationManifest(activeKey, retiredManifest(), identity);
    const values = manifest.items.map((manifestItem) =>
      payload(payloadValues[manifestItem.name as keyof typeof payloadValues]),
    );

    expect(decodeRetiredDataPublicationItems(manifest, values)).toEqual(payloadValues);
    expect(retiredDataActivePattern(identity)).toBe('llm:v*:data:fpl:live:2627:3:active');
    expect(parseRetiredDataActiveKeyScope(activeKey)).toEqual({
      dataset: 'fpl:live',
      seasonCode: '2627',
      eventId: 3,
    });
  });

  test('rejects payload drift, extra manifest fields, and mismatched publication authority', () => {
    const activeKey = 'llm:v3:data:fpl:live:2627:3:active';
    const manifest = parseRetiredDataPublicationManifest(activeKey, retiredManifest(), identity);
    const values = manifest.items.map((manifestItem) =>
      payload(payloadValues[manifestItem.name as keyof typeof payloadValues]),
    );
    values[0] = `${values[0]} `;
    expect(() => decodeRetiredDataPublicationItems(manifest, values)).toThrow('integrity');

    const withExtraField = JSON.parse(retiredManifest()) as Record<string, unknown>;
    withExtraField.compatibility = true;
    expect(() =>
      parseRetiredDataPublicationManifest(activeKey, JSON.stringify(withExtraField), identity),
    ).toThrow('field set');
    expect(() =>
      parseRetiredDataPublicationManifest(activeKey, retiredManifest(), {
        ...identity,
        revision: 42,
      }),
    ).toThrow('database publication');
  });

  test('only recognizes exact retired Data keys and maps coordination state once', () => {
    expect(isRetiredDataKey('llm:v3:data:fpl:core:2627:2:players')).toBe(true);
    expect(isRetiredDataKey('llm:v3:data:fpl:core:2627:active')).toBe(true);
    expect(isRetiredDataKey('llm:v3:data:unknown')).toBe(false);
    expect(canonicalCoordinationKey('llm:v3:queue:coordination:launch:done')).toBe(
      'llm:queue:coordination:launch:done',
    );
    expect(canonicalCoordinationKey('llm:queue:coordination:launch:done')).toBeNull();
    expect(buildCoordinationMigrationPairs(['llm:v3:queue:coordination:launch:done'])).toEqual([
      {
        source: 'llm:v3:queue:coordination:launch:done',
        target: 'llm:queue:coordination:launch:done',
      },
    ]);
    expect(() =>
      buildCoordinationMigrationPairs([
        'llm:v2:queue:coordination:launch:done',
        'llm:v3:queue:coordination:launch:done',
      ]),
    ).toThrow('Multiple retired coordination keys');
  });
});
