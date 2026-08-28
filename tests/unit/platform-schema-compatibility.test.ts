import { describe, expect, test } from 'bun:test';
import expectedExportNames from '../fixtures/platform-schema-export-names.json';
import * as platformSchema from '../../src/db/schemas/platform.schema';
import * as competitionSchema from '../../src/db/schemas/platform/competition.schema';
import * as fplMarketSchema from '../../src/db/schemas/platform/fpl-market.schema';
import * as fplSchema from '../../src/db/schemas/platform/fpl.schema';
import * as namespacesSchema from '../../src/db/schemas/platform/namespaces.schema';
import * as opsSchema from '../../src/db/schemas/platform/ops.schema';
import * as reportingSchema from '../../src/db/schemas/platform/reporting.schema';
import * as understatBridgeSchema from '../../src/db/schemas/platform/understat-bridge.schema';

const splitModules = [
  namespacesSchema,
  fplSchema,
  understatBridgeSchema,
  opsSchema,
  competitionSchema,
  fplMarketSchema,
  reportingSchema,
] as const;

describe('platform schema compatibility barrel', () => {
  test('preserves the pre-split Drizzle runtime export names', () => {
    expect(Object.keys(platformSchema).sort()).toEqual(expectedExportNames);
  });

  test('exports every split declaration exactly once', () => {
    const splitNames = splitModules.flatMap((module) => Object.keys(module));
    expect(splitNames).toHaveLength(new Set(splitNames).size);
    expect(splitNames.sort()).toEqual(expectedExportNames);
  });
});
