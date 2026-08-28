import { describe, expect, test } from 'bun:test';

import { loadBriefingManifest } from '../../../src/content/acquisition/acquisition-manifest';
import {
  deterministicScheduleJitterMs,
  initialEndpointIdentity,
  reconcileEndpointIdentity,
} from '../../../src/content/acquisition/manifest-reconciler';
import { getAcquisitionProfile } from '../../../src/content/acquisition/acquisition-profiles';
import { compileBriefingRegistryState } from '../../../src/content/acquisition/registry-state';

describe('Briefing source manifest reconciler', () => {
  test('treats configured semantic and YouTube IDs as stable identities', async () => {
    const state = compileBriefingRegistryState(await loadBriefingManifest());
    const now = new Date('2026-08-22T00:00:00.000Z');
    const semantic = state.endpoints.find((endpoint) => endpoint.adapterKind === 'X_SEMANTIC');
    const youtube = state.endpoints.find(
      (endpoint) => endpoint.endpointKey === 'fpl-focal-youtube',
    );

    expect(semantic && initialEndpointIdentity(semantic, now)).toMatchObject({
      identityStatus: 'VERIFIED',
      identityNextCheckAt: null,
    });
    expect(youtube && initialEndpointIdentity(youtube, now)).toMatchObject({
      identityStatus: 'VERIFIED',
      stableExternalId: 'UC72QokPHXQ9r98ROfNZmaDw',
    });
  });

  test('requires identities only for official FPL and club endpoints', async () => {
    const state = compileBriefingRegistryState(await loadBriefingManifest());
    const accounts = state.endpoints.filter((endpoint) => endpoint.adapterKind === 'X_ACCOUNT');
    const required = accounts.filter((endpoint) => endpoint.identityRequirement === 'REQUIRED');
    const handleOnly = accounts.filter(
      (endpoint) => endpoint.identityRequirement === 'HANDLE_ONLY',
    );
    const requiredSourceKeys = new Set(
      state.entities
        .filter((entity) =>
          ['OFFICIAL_FPL', 'LEAGUE_OFFICIAL', 'CLUB_OFFICIAL'].includes(entity.sourceType),
        )
        .map((entity) => entity.sourceKey),
    );

    expect(required).toHaveLength(22);
    expect(handleOnly.length).toBeGreaterThan(0);
    expect(required.every((endpoint) => requiredSourceKeys.has(endpoint.sourceKey))).toBe(true);
    expect(
      handleOnly.every(
        (endpoint) => initialEndpointIdentity(endpoint, new Date()).identityNextCheckAt === null,
      ),
    ).toBe(true);
  });

  test('does not retain a legacy numeric identity for handle-only endpoints', async () => {
    const state = compileBriefingRegistryState(await loadBriefingManifest());
    const endpoint = state.endpoints.find((item) => item.endpointKey === 'ben-dinnery-x');
    expect(endpoint?.identityRequirement).toBe('HANDLE_ONLY');
    if (!endpoint) return;

    expect(
      reconcileEndpointIdentity({
        endpoint,
        existing: {
          adapterKind: 'X_ACCOUNT',
          profileKey: endpoint.profileKey,
          locator: { handle: 'BenDinnery' },
          stableExternalId: '123456789',
          identityStatus: 'VERIFIED',
          identityErrorSummary: null,
          identityCheckedAt: new Date('2026-08-01T00:00:00.000Z'),
          identityNextCheckAt: new Date('2026-08-31T00:00:00.000Z'),
        },
        now: new Date('2026-08-22T00:00:00.000Z'),
      }),
    ).toEqual({
      stableExternalId: null,
      identityStatus: 'PENDING',
      identityErrorSummary: null,
      identityCheckedAt: null,
      identityNextCheckAt: null,
    });
  });

  test('never silently rebinds a changed configured stable identity', async () => {
    const state = compileBriefingRegistryState(await loadBriefingManifest());
    const youtube = state.endpoints.find((endpoint) => endpoint.adapterKind === 'YOUTUBE_CHANNEL');
    expect(youtube).toBeDefined();
    if (!youtube) return;

    const reconciled = reconcileEndpointIdentity({
      endpoint: youtube,
      existing: {
        adapterKind: 'YOUTUBE_CHANNEL',
        profileKey: youtube.profileKey,
        locator: { channelId: 'UC0000000000000000000000' },
        stableExternalId: 'UC0000000000000000000000',
        identityStatus: 'VERIFIED',
        identityErrorSummary: null,
        identityCheckedAt: new Date('2026-08-01T00:00:00.000Z'),
        identityNextCheckAt: null,
      },
      now: new Date('2026-08-22T00:00:00.000Z'),
    });

    expect(reconciled).toMatchObject({
      identityStatus: 'CONFLICT',
      stableExternalId: 'UC0000000000000000000000',
    });
  });

  test('moves a changed X handle back to pending without losing its stable user ID', async () => {
    const state = compileBriefingRegistryState(await loadBriefingManifest());
    const endpoint = state.endpoints.find((item) => item.endpointKey === 'official-fpl-x');
    expect(endpoint).toBeDefined();
    if (!endpoint) return;
    const now = new Date('2026-08-22T00:00:00.000Z');

    expect(
      reconcileEndpointIdentity({
        endpoint,
        existing: {
          adapterKind: 'X_ACCOUNT',
          profileKey: endpoint.profileKey,
          locator: { handle: 'OldOfficialFPL' },
          stableExternalId: '123456789',
          identityStatus: 'VERIFIED',
          identityErrorSummary: null,
          identityCheckedAt: new Date('2026-08-01T00:00:00.000Z'),
          identityNextCheckAt: null,
        },
        now,
      }),
    ).toEqual({
      stableExternalId: '123456789',
      identityStatus: 'PENDING',
      identityErrorSummary: null,
      identityCheckedAt: new Date('2026-08-01T00:00:00.000Z'),
      identityNextCheckAt: now,
    });
  });

  test('uses stable bounded startup jitter', () => {
    const input = {
      scheduleKey: 'partition-official-fpl',
      adapterKind: 'X_ACCOUNT' as const,
      profileKey: 'x-official-v1',
    };
    const first = deterministicScheduleJitterMs(input);
    expect(first).toBe(deterministicScheduleJitterMs(input));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(
      (getAcquisitionProfile(input.profileKey)?.cadenceMinutes.NORMAL ?? 0) * 60_000,
    );
  });
});
