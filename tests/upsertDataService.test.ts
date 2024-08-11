import { describe, test } from '@jest/globals';
import { upsertStaticData } from '../src/services/upsertDataService';

describe('upsertStaticData', () => {
  jest.setTimeout(5000000);
  test('upsert bootstrap static data', async () => {
    await upsertStaticData();
  });
});
