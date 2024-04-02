import { afterAll, describe, test } from '@jest/globals';
import { server } from '../src/index';
import { upsertStaticData } from '../src/services/upsertDataService';

describe('upsertStaticData', () => {
  test('upsert bootstrap static data', async () => {
    await upsertStaticData();
  });
});

afterAll((done) => {
  server.close(done);
});
