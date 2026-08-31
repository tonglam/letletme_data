import { describe, expect, test } from 'bun:test';

import {
  assertRetireAuthorization,
  parseRetireCoreStagingArguments,
} from '../../scripts/retire-superseded-core-staging-publication';

const PUBLICATION_ID = '0257fd66-864f-4637-8565-e8108317b648';
const ACTIVE_PUBLICATION_ID = '91a5e72f-2b69-416f-a4c9-36a8627a35aa';

describe('superseded core staging repair command', () => {
  test('parses one exact publication and active revision fence', () => {
    expect(
      parseRetireCoreStagingArguments([
        '--action',
        'inspect',
        '--publication-id',
        PUBLICATION_ID.toUpperCase(),
        '--season-id=2026',
        '--expected-active-publication-id',
        ACTIVE_PUBLICATION_ID,
        '--expected-active-revision',
        '3824',
      ]),
    ).toEqual({
      action: 'inspect',
      publicationId: PUBLICATION_ID,
      seasonId: 2026,
      expectedActivePublicationId: ACTIVE_PUBLICATION_ID,
      expectedActiveRevision: 3824,
      reason: null,
    });
  });

  test('requires an operator reason for a destructive retire', () => {
    expect(() =>
      parseRetireCoreStagingArguments([
        '--action=retire',
        '--publication-id',
        PUBLICATION_ID,
        '--season-id',
        '2026',
        '--expected-active-publication-id',
        ACTIVE_PUBLICATION_ID,
        '--expected-active-revision',
        '3824',
      ]),
    ).toThrow('--reason is required');
  });

  test('rejects malformed or duplicate exact-scope arguments', () => {
    expect(() =>
      parseRetireCoreStagingArguments([
        '--action',
        'inspect',
        '--publication-id',
        'not-a-uuid',
        '--publication-id',
        PUBLICATION_ID,
        '--season-id',
        '2026',
        '--expected-active-publication-id',
        ACTIVE_PUBLICATION_ID,
        '--expected-active-revision',
        '3824',
      ]),
    ).toThrow('--publication-id');
  });

  test('requires explicit confirmation only for the write action', () => {
    expect(() => assertRetireAuthorization('inspect', {})).not.toThrow();
    expect(() => assertRetireAuthorization('retire', {})).toThrow(
      'DATA_STAGING_REPAIR_CONFIRM=YES',
    );
    expect(() =>
      assertRetireAuthorization('retire', { DATA_STAGING_REPAIR_CONFIRM: 'YES' }),
    ).not.toThrow();
  });
});
