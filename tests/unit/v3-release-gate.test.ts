import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  decodeV3ReleaseManifest,
  evaluateV3ReleaseGate,
  type V3ReleaseGateInput,
  type V3ReleaseManifest,
} from '../../scripts/v3-release-gate';

const runId = 'v3-20260808T160000Z-62f134a';
const dataSha = '1'.repeat(40);
const manifest: V3ReleaseManifest = {
  schemaVersion: 'v3',
  planVersion: '3.0.0',
  status: 'approved',
  cutoverRunId: runId,
  dataSha,
  graphqlSha: '2'.repeat(40),
  webSha: '3'.repeat(40),
  dataImageDigest: `sha256:${'4'.repeat(64)}`,
  approvedAt: '2026-08-08T16:00:00.000Z',
};
const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestSha256 = createHash('sha256').update(manifestContents).digest('hex');

function validInput(overrides: Partial<V3ReleaseGateInput> = {}): V3ReleaseGateInput {
  return {
    hasActivationMigration: true,
    manifest,
    manifestContents,
    deploySha: dataSha,
    deployImageDigest: manifest.dataImageDigest ?? undefined,
    cutoverRunId: runId,
    manifestSha256,
    activationApproval: `APPROVE_V3_ACTIVATION ${runId}`,
    ...overrides,
  };
}

describe('v3 release gate', () => {
  test('does not affect deployments before migration 0079 exists', () => {
    expect(evaluateV3ReleaseGate(validInput({ hasActivationMigration: false }))).toEqual({
      required: false,
    });
  });

  test('accepts an exact approved release manifest and activation token', () => {
    expect(evaluateV3ReleaseGate(validInput())).toEqual({
      required: true,
      runId,
      dataSha,
      manifestSha256,
    });
  });

  test('decodes a canonical external release manifest', () => {
    expect(decodeV3ReleaseManifest(Buffer.from(manifestContents).toString('base64'))).toEqual({
      manifest,
      manifestContents,
    });
  });

  test.each([
    ['locked manifest', { manifest: { ...manifest, status: 'locked' as const } }],
    ['wrong deploy SHA', { deploySha: '5'.repeat(40) }],
    ['wrong image digest', { deployImageDigest: `sha256:${'5'.repeat(64)}` }],
    ['wrong run ID', { cutoverRunId: 'v3-20260808T160001Z-62f134a' }],
    ['wrong manifest digest', { manifestSha256: '6'.repeat(64) }],
    ['missing approval', { activationApproval: undefined }],
  ])('blocks %s', (_name, overrides) => {
    expect(() => evaluateV3ReleaseGate(validInput(overrides))).toThrow();
  });

  test.each([undefined, 'not-base64', 'e30'])('blocks invalid external manifest %s', (encoded) => {
    expect(() => decodeV3ReleaseManifest(encoded)).toThrow();
  });
});
