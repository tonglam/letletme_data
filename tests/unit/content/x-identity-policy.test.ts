import { describe, expect, test } from 'bun:test';

import { xEndpointMayScan } from '../../../src/content/acquisition/x-identity-policy';

describe('X identity acquisition policy', () => {
  test('allows handle-only X accounts without a verified numeric identity', () => {
    expect(
      xEndpointMayScan({
        adapterKind: 'X_ACCOUNT',
        identityRequirement: 'HANDLE_ONLY',
        identityStatus: 'PENDING',
      }),
    ).toBe(true);
  });

  test('keeps official X accounts behind the verified identity gate', () => {
    expect(
      xEndpointMayScan({
        adapterKind: 'X_ACCOUNT',
        identityRequirement: 'REQUIRED',
        identityStatus: 'PENDING',
      }),
    ).toBe(false);
    expect(
      xEndpointMayScan({
        adapterKind: 'X_ACCOUNT',
        identityRequirement: 'REQUIRED',
        identityStatus: 'VERIFIED',
      }),
    ).toBe(true);
  });

  test('keeps semantic and YouTube stable identity gates intact', () => {
    expect(
      xEndpointMayScan({
        adapterKind: 'X_SEMANTIC',
        identityRequirement: 'NOT_APPLICABLE',
        identityStatus: 'VERIFIED',
      }),
    ).toBe(true);
    expect(
      xEndpointMayScan({
        adapterKind: 'YOUTUBE_CHANNEL',
        identityRequirement: 'NOT_APPLICABLE',
        identityStatus: 'VERIFIED',
      }),
    ).toBe(true);
    expect(
      xEndpointMayScan({
        adapterKind: 'YOUTUBE_CHANNEL',
        identityRequirement: 'NOT_APPLICABLE',
        identityStatus: 'PENDING',
      }),
    ).toBe(false);
  });
});
