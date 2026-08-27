import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const unitDirectory = join(process.cwd(), 'tests', 'unit');

async function collectUnitFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectUnitFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

const files = (await collectUnitFiles(unitDirectory)).sort();

if (files.length === 0) {
  throw new Error('No unit test files found');
}

const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:1/unit',
  CACHE_REDIS_HOST: '127.0.0.1',
  CACHE_REDIS_PORT: '1',
  CACHE_REDIS_DB: '9',
  QUEUE_REDIS_HOST: '127.0.0.1',
  QUEUE_REDIS_PORT: '2',
  QUEUE_REDIS_DB: '10',
} as Record<string, string>;
delete env.RUN_INTEGRATION;

for (const file of files) {
  process.stdout.write(`[unit-isolated] ${file}\n`);
  // Keep the child's streams as pipes and forward them ourselves. Bun 1.2
  // has an output-mode-dependent scheduler path for async tests that mutate
  // process globals; inheriting a redirected file descriptor can make those
  // tests race, while a pipe preserves the normal test-runner behavior.
  const child = Bun.spawn([process.execPath, 'test', file], {
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const forward = async (
    stream: ReadableStream<Uint8Array>,
    target: { write(chunk: Uint8Array): boolean },
  ) => {
    for await (const chunk of stream) {
      target.write(chunk);
    }
  };
  await Promise.all([forward(child.stdout, process.stdout), forward(child.stderr, process.stderr)]);
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
