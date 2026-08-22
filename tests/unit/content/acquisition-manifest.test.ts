import { describe, expect, test } from 'bun:test';

import {
  BriefingManifestError,
  parseBriefingManifest,
} from '../../../src/content/acquisition/acquisition-manifest';
import { ACQUISITION_PROFILES } from '../../../src/content/acquisition/acquisition-profiles';

const sourcesUrl = new URL('../../../config/briefing/sources.yaml', import.meta.url);
const planUrl = new URL('../../../config/briefing/acquisition-plan.yaml', import.meta.url);
const coverageSnapshotUrl = new URL(
  '../../../config/briefing/coverage.snapshot.json',
  import.meta.url,
);

async function manifests(): Promise<{ sourcesYaml: string; acquisitionPlanYaml: string }> {
  const [sourcesYaml, acquisitionPlanYaml] = await Promise.all([
    Bun.file(sourcesUrl).text(),
    Bun.file(planUrl).text(),
  ]);
  return { sourcesYaml, acquisitionPlanYaml };
}

describe('Briefing acquisition manifest', () => {
  test('compiles the real manifest with complete club reporting coverage', async () => {
    const bundle = parseBriefingManifest(await manifests());
    expect(bundle.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.coverage.entityCount).toBe(85);
    expect(bundle.coverage.endpointCount).toBe(108);
    expect(bundle.coverage.endpointCounts).toEqual({
      X_ACCOUNT: 83,
      X_SEMANTIC: 4,
      RSS_ATOM: 3,
      PODCAST_FEED: 7,
      YOUTUBE_CHANNEL: 11,
    });
    expect(bundle.coverage.partitionCount).toBe(44);
    expect(bundle.coverage.forecastCalls).toEqual({
      NORMAL: 1794,
      APPROACHING: 4548,
      FINAL90: 8616,
    });
    expect(
      Object.values(bundle.coverage.xLaneForecastCalls.NORMAL).reduce(
        (total, calls) => total + calls,
        0,
      ),
    ).toBe(1026);
    expect(
      Object.values(bundle.coverage.xLaneForecastCalls.FINAL90).reduce(
        (total, calls) => total + calls,
        0,
      ),
    ).toBe(401);
    expect(
      Object.values(bundle.coverage.xLaneCallCaps.FINAL90).reduce(
        (total, calls) => total + calls,
        0,
      ),
    ).toBe(484);
    expect(bundle.coverage.clubs.every((club) => club.officialMissing === 0)).toBe(true);
    expect(
      bundle.coverage.clubs.reduce((total, club) => total + club.primaryReportingMissing, 0),
    ).toBe(0);
    expect(bundle.coverage.fullRolloutEligible).toBe(true);
    expect(bundle.coverage).toEqual(await Bun.file(coverageSnapshotUrl).json());
  });

  test('rejects case-insensitive duplicate X handles', async () => {
    const input = await manifests();
    expect(() =>
      parseBriefingManifest({
        ...input,
        sourcesYaml: input.sourcesYaml.replace('handle: FPLGeneral', 'handle: officialfpl'),
      }),
    ).toThrow(BriefingManifestError);
    try {
      parseBriefingManifest({
        ...input,
        sourcesYaml: input.sourcesYaml.replace('handle: FPLGeneral', 'handle: officialfpl'),
      });
    } catch (error) {
      expect((error as BriefingManifestError).issues.join(' ')).toContain('duplicate locator');
    }
  });

  test('rejects an enabled X endpoint in two partitions', async () => {
    const input = await manifests();
    const acquisitionPlanYaml = input.acquisitionPlanYaml.replace(
      'endpointKeys: [premier-league-x]',
      'endpointKeys: [official-fpl-x, premier-league-x]',
    );
    expect(() => parseBriefingManifest({ ...input, acquisitionPlanYaml })).toThrow(
      /belongs to official-fpl and official-premier-league/,
    );
  });

  test('allows a source-level pause after its recurring partition is removed', async () => {
    const input = await manifests();
    const sourcesYaml = input.sourcesYaml.replace(
      '    displayName: Official FPL\n    endpoints:',
      '    displayName: Official FPL\n    enabled: false\n    endpoints:',
    );
    const acquisitionPlanYaml = input.acquisitionPlanYaml.replace(
      '  - partitionKey: official-fpl\n    profileKey: x-official-v1\n    priority: 10\n    endpointKeys: [official-fpl-x]\n',
      '',
    );

    const paused = parseBriefingManifest({ sourcesYaml, acquisitionPlanYaml });
    expect(paused.coverage.entityCount).toBe(84);
    expect(paused.coverage.partitionCount).toBe(43);
  });

  test('rejects unsupported social adapters instead of silently accepting them', async () => {
    const input = await manifests();
    const sourcesYaml = input.sourcesYaml.replace(
      'adapterKind: X_ACCOUNT',
      'adapterKind: INSTAGRAM',
    );
    expect(() => parseBriefingManifest({ ...input, sourcesYaml })).toThrow(/Invalid enum value/);
  });

  test('locks profile bootstrap limits in versioned code', () => {
    expect(ACQUISITION_PROFILES['podcast-public-v1']?.bootstrap).toEqual({
      lookbackMinutes: 20160,
      maxItems: 3,
      maxContentJobs: 1,
    });
    expect(ACQUISITION_PROFILES['youtube-caption-first-v1']?.bootstrap).toEqual({
      lookbackMinutes: 20160,
      maxItems: 15,
      maxContentJobs: 5,
    });
  });
});
