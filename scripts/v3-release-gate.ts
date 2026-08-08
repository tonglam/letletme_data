/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';

export const V3_ACTIVATION_MIGRATION = 'migrations/0079_create_v3_ops_and_roles.sql';

export type V3ReleaseManifest = {
  schemaVersion: 'v3';
  planVersion: string;
  status: 'locked' | 'approved';
  cutoverRunId: string | null;
  dataSha: string | null;
  graphqlSha: string | null;
  webSha: string | null;
  dataImageDigest: string | null;
  approvedAt: string | null;
};

export type V3ReleaseGateInput = {
  hasActivationMigration: boolean;
  manifest: V3ReleaseManifest;
  manifestContents: string;
  deploySha: string | undefined;
  deployImageDigest: string | undefined;
  cutoverRunId: string | undefined;
  manifestSha256: string | undefined;
  activationApproval: string | undefined;
};

export type V3ReleaseGateResult =
  | { required: false }
  | { required: true; runId: string; dataSha: string; manifestSha256: string };

const RUN_ID_PATTERN = /^v3-\d{8}T\d{6}Z-[0-9a-f]{7,12}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const sha256 = (contents: string): string =>
  createHash('sha256').update(contents, 'utf8').digest('hex');

function requireEqual(name: string, actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new Error(`${name} does not match the approved v3 release manifest`);
  }
}

export function evaluateV3ReleaseGate(input: V3ReleaseGateInput): V3ReleaseGateResult {
  if (!input.hasActivationMigration) return { required: false };

  const { manifest } = input;
  if (manifest.schemaVersion !== 'v3' || manifest.status !== 'approved') {
    throw new Error('v3 release manifest is locked or invalid');
  }
  if (!manifest.cutoverRunId || !RUN_ID_PATTERN.test(manifest.cutoverRunId)) {
    throw new Error('v3 release manifest has an invalid cutover run ID');
  }
  if (!manifest.dataSha || !COMMIT_SHA_PATTERN.test(manifest.dataSha)) {
    throw new Error('v3 release manifest has an invalid Data commit SHA');
  }
  if (!manifest.graphqlSha || !COMMIT_SHA_PATTERN.test(manifest.graphqlSha)) {
    throw new Error('v3 release manifest has an invalid GraphQL commit SHA');
  }
  if (!manifest.webSha || !COMMIT_SHA_PATTERN.test(manifest.webSha)) {
    throw new Error('v3 release manifest has an invalid Web commit SHA');
  }
  if (!manifest.dataImageDigest || !/^sha256:[0-9a-f]{64}$/.test(manifest.dataImageDigest)) {
    throw new Error('v3 release manifest has an invalid Data image digest');
  }
  if (!manifest.approvedAt || Number.isNaN(Date.parse(manifest.approvedAt))) {
    throw new Error('v3 release manifest has an invalid approval timestamp');
  }

  const expectedManifestSha = sha256(input.manifestContents);
  if (!input.manifestSha256 || !SHA256_PATTERN.test(input.manifestSha256)) {
    throw new Error('V3_RELEASE_MANIFEST_SHA256 must be a lowercase SHA-256 digest');
  }
  requireEqual('V3_RELEASE_MANIFEST_SHA256', input.manifestSha256, expectedManifestSha);
  requireEqual('V3_CUTOVER_RUN_ID', input.cutoverRunId, manifest.cutoverRunId);
  requireEqual('DEPLOY_SHA', input.deploySha, manifest.dataSha);
  requireEqual('DEPLOY_IMAGE_DIGEST', input.deployImageDigest, manifest.dataImageDigest);
  requireEqual(
    'V3_CUTOVER_APPROVAL',
    input.activationApproval,
    `APPROVE_V3_ACTIVATION ${manifest.cutoverRunId}`,
  );

  return {
    required: true,
    runId: manifest.cutoverRunId,
    dataSha: manifest.dataSha,
    manifestSha256: expectedManifestSha,
  };
}

export function decodeV3ReleaseManifest(encoded: string | undefined): {
  manifest: V3ReleaseManifest;
  manifestContents: string;
} {
  if (!encoded) {
    throw new Error('V3_RELEASE_MANIFEST_BASE64 is required');
  }

  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error('V3_RELEASE_MANIFEST_BASE64 is not canonical base64');
  }

  const manifestContents = Buffer.from(normalized, 'base64').toString('utf8');
  if (Buffer.from(manifestContents, 'utf8').toString('base64') !== normalized) {
    throw new Error('V3_RELEASE_MANIFEST_BASE64 is not canonical base64');
  }

  let manifest: V3ReleaseManifest;
  try {
    manifest = JSON.parse(manifestContents) as V3ReleaseManifest;
  } catch {
    throw new Error('V3_RELEASE_MANIFEST_BASE64 does not contain valid JSON');
  }

  return { manifest, manifestContents };
}

async function main(): Promise<void> {
  const hasActivationMigration = existsSync(V3_ACTIVATION_MIGRATION);
  if (!hasActivationMigration) {
    console.log('[v3-release-gate] v3 activation migration absent; gate not required');
    return;
  }

  const { manifest, manifestContents } = decodeV3ReleaseManifest(
    process.env.V3_RELEASE_MANIFEST_BASE64,
  );
  const result = evaluateV3ReleaseGate({
    hasActivationMigration,
    manifest,
    manifestContents,
    deploySha: process.env.DEPLOY_SHA,
    deployImageDigest: process.env.DEPLOY_IMAGE_DIGEST,
    cutoverRunId: process.env.V3_CUTOVER_RUN_ID,
    manifestSha256: process.env.V3_RELEASE_MANIFEST_SHA256,
    activationApproval: process.env.V3_CUTOVER_APPROVAL,
  });

  if (result.required) {
    console.log(`[v3-release-gate] approved run ${result.runId} for Data ${result.dataSha}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[v3-release-gate] blocked', error);
    process.exitCode = 1;
  });
}
