import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

export const testJob = () =>
  new Elysia().use(
    cron({
      name: 'test',
      pattern: '*/10 * * * * *',
      run() {
        console.log('test');
      },
    }),
  );
