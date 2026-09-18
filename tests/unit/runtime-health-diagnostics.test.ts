import { describe, expect, test } from 'bun:test';

const sha = '0123456789abcdef0123456789abcdef01234567';
const dependencies = {
  postgres: true,
  cacheRedis: true,
  queueRedis: true,
  activeSeason: true,
  screenshotRetentionConfigured: true,
  scheduler: true,
  queueWorker: true,
  contentWorker: true,
  livePicksWorker: true,
  officialH2HWorker: true,
  publicationConsistency: true,
  mediaWorker: true,
};

async function verify(
  response: (attempt: number) => Response,
  environment: Record<string, string> = {},
  liveResponse: (attempt: number) => Response = () => new Response('ok'),
) {
  let attempt = 0;
  let liveAttempt = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/health/live') return liveResponse(++liveAttempt);
      return response(++attempt);
    },
  });
  try {
    const process = Bun.spawn(
      [
        'bash',
        '-c',
        `health_compose() { if [[ "$*" == *'ps -q'* ]]; then echo test-container; fi; }
docker() { echo healthy; }
export -f health_compose docker
exec bash scripts/verify-runtime-health.sh`,
      ],
      {
        env: {
          ...globalThis.process.env,
          API_HEALTH_URL: `http://127.0.0.1:${server.port}`,
          COMPOSE_BIN: 'health_compose',
          EXPECTED_DEPLOY_SHA: sha,
          HEALTH_ATTEMPTS: '1',
          HEALTH_DELAY_SECONDS: '0',
          HEALTH_DEADLINE_SECONDS: '10',
          HEALTH_CURL_TIMEOUT_SECONDS: '2',
          RUNTIME_HEALTH_CORE_ONLY: 'false',
          ...environment,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, attempt };
  } finally {
    server.stop(true);
  }
}

describe('runtime health failure diagnostics', () => {
  test('retains only the latest 503 dependency failure and redacts arbitrary fields', async () => {
    const result = await verify(
      (attempt) =>
        Response.json(
          {
            status: 'deploy_not_ready',
            deploySha: sha,
            dependencies: {
              ...dependencies,
              postgres: attempt !== 1,
              queueRedis: attempt === 1,
            },
            error: 'postgres://private-user:secret-password@private-host',
            token: 'private-token',
          },
          { status: 503 },
        ),
      { HEALTH_ATTEMPTS: '2' },
    );
    expect(result.exitCode).toBe(1);
    expect(result.attempt).toBe(2);
    expect(result.stderr).toContain('curl_exit=22');
    expect(result.stderr).toContain('"queueRedis":false');
    expect(result.stderr).toContain('"postgres":true');
    expect(result.stderr).not.toContain('"postgres":false');
    expect(result.stderr).not.toContain('private-');
    expect(result.stderr).not.toContain('secret-password');
    expect(result.stderr.length).toBeLessThan(1200);
  });

  test('rejects 503 without expected identity and still reports dependencies', async () => {
    const result = await verify(
      () => Response.json({ dependencies: { queueWorker: false } }, { status: 503 }),
      { EXPECTED_DEPLOY_SHA: '' },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"queueWorker":false');
  });

  test('keeps malformed and oversized response diagnostics bounded and redacted', async () => {
    for (const body of ['private-token <html>broken</html>', 'private-token'.repeat(20_000)]) {
      const result = await verify(() => new Response(body, { status: 503 }));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('last health probe');
      expect(result.stderr).not.toContain('private-token');
      expect(result.stderr.length).toBeLessThan(1200);
    }
  });

  test('does not label an earlier deploy body as current after a live probe failure', async () => {
    const result = await verify(
      () => Response.json({ dependencies: { queueRedis: false } }, { status: 503 }),
      { HEALTH_ATTEMPTS: '2' },
      (attempt) => new Response('live', { status: attempt === 1 ? 200 : 503 }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.attempt).toBe(1);
    expect(result.stderr).toContain('endpoint=/health/live curl_exit=22');
    expect(result.stderr).toContain('/health/deploy=not-attempted');
    expect(result.stderr).toMatch(/observed_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(result.stderr).not.toContain('"queueRedis":false');
  });

  test('accepts normal health and distinguishes readiness failure from identity failure', async () => {
    const healthy = await verify(() =>
      Response.json({ status: 'deploy_ready', deploySha: sha, dependencies }),
    );
    expect(healthy.exitCode, healthy.stderr).toBe(0);
    const wrongIdentity = await verify(() =>
      Response.json({ status: 'deploy_ready', deploySha: 'a'.repeat(40), dependencies }),
    );
    expect(wrongIdentity.exitCode).toBe(1);
    expect(wrongIdentity.stderr).toContain(`"deploySha":"${'a'.repeat(40)}"`);
  });

  test('core-only recovery accepts media-only 503 but rejects core dependency failure', async () => {
    for (const queueWorker of [true, false]) {
      const result = await verify(
        () =>
          Response.json(
            {
              status: 'deploy_not_ready',
              deploySha: sha,
              dependencies: { ...dependencies, mediaWorker: false, queueWorker },
            },
            { status: 503 },
          ),
        { RUNTIME_HEALTH_CORE_ONLY: 'true' },
      );
      expect(result.exitCode, result.stderr).toBe(queueWorker ? 0 : 1);
    }
  });
});
