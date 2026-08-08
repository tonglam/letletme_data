import { mkdir } from 'node:fs/promises';

type EndpointKind = 'league' | 'team' | 'match';

interface RawFileRecord {
  kind: EndpointKind;
  id: string;
  path: string;
  file: string;
  bytes: number;
  sha256: string;
}

interface CaptureFailure {
  kind: EndpointKind;
  id: string;
  path: string;
  error: string;
}

interface RawCaptureManifest {
  schemaVersion: 1;
  provider: 'understat';
  league: string;
  season: string;
  sourceYear: number;
  capturedAt: string;
  baseUrl: string;
  status: 'complete' | 'failed';
  counts: {
    expected: { league: number; teams: number; matches: number };
    captured: { league: number; teams: number; matches: number };
  };
  files: RawFileRecord[];
  failures: CaptureFailure[];
}

const headers = {
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'letletme-data/1.0.0 (+https://github.com/tonglam/letletme_data)',
  Accept: 'application/json,text/javascript;q=0.9,*/*;q=0.1',
};

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value?.slice(prefix.length);
}

function requiredArgument(name: string, fallback?: string): string {
  const value = argument(name) ?? fallback;
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function defaultOutputDirectory(season: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `data/raw/understat/${season}/${stamp}`;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Understat league response field ${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function positiveId(value: unknown, name: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Understat ${name} is not a positive integer`);
  }
  return parsed;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(date - Date.now(), 0);
}

async function fetchRaw(
  baseUrl: string,
  path: string,
  timeoutMilliseconds: number,
  attempts: number,
): Promise<string> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const response = await fetch(`${baseUrl}${path}`, { headers, signal: controller.signal });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429) throw new Error(lastError);
        if (attempt < attempts) {
          await sleep(retryAfterMilliseconds(response) ?? Math.min(1_000 * 2 ** attempt, 10_000));
          continue;
        }
        throw new Error(lastError);
      }
      const body = await response.text();
      if (body.trim().length === 0) throw new Error('empty response');
      JSON.parse(body);
      return body;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts) throw new Error(lastError);
      await sleep(Math.min(1_000 * 2 ** attempt, 10_000));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError);
}

async function captureFile(input: {
  baseUrl: string;
  outputDirectory: string;
  kind: EndpointKind;
  id: string;
  path: string;
  file: string;
  timeoutMilliseconds: number;
  attempts: number;
}): Promise<RawFileRecord> {
  const body = await fetchRaw(input.baseUrl, input.path, input.timeoutMilliseconds, input.attempts);
  const target = `${input.outputDirectory}/${input.file}`;
  await Bun.write(target, body);
  return {
    kind: input.kind,
    id: input.id,
    path: input.path,
    file: input.file,
    bytes: new TextEncoder().encode(body).byteLength,
    sha256: await sha256(body),
  };
}

async function capturePool(
  inputs: Array<Parameters<typeof captureFile>[0]>,
  concurrency: number,
): Promise<{ records: RawFileRecord[]; failures: CaptureFailure[] }> {
  const records: RawFileRecord[] = [];
  const failures: CaptureFailure[] = [];
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const input = inputs[index];
      if (!input) return;
      try {
        records.push(await captureFile(input));
        process.stdout.write(`captured ${input.kind} ${input.id}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ kind: input.kind, id: input.id, path: input.path, error: message });
        process.stderr.write(`failed ${input.kind} ${input.id}: ${message}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return { records, failures };
}

async function main(): Promise<void> {
  const season = requiredArgument('season');
  if (!/^\d{4}$/.test(season) || Number(season.slice(2)) !== Number(season.slice(0, 2)) + 1) {
    throw new Error(`season must be a consecutive four-digit key, got ${season}`);
  }
  const league = requiredArgument('league', process.env.UNDERSTAT_LEAGUE ?? 'EPL');
  const sourceYear = Number(season.slice(0, 2)) + 2000;
  const baseUrl = (
    argument('base-url') ??
    process.env.UNDERSTAT_BASE_URL ??
    'https://understat.com'
  ).replace(/\/$/, '');
  const outputDirectory = argument('out') ?? defaultOutputDirectory(season);
  const concurrency = Math.min(
    positiveInteger(
      argument('concurrency') ?? process.env.UNDERSTAT_MAX_CONCURRENCY ?? '4',
      'concurrency',
    ),
    4,
  );
  const timeoutMilliseconds = positiveInteger(
    argument('timeout-ms') ?? process.env.UNDERSTAT_TIMEOUT_MS ?? '10000',
    'timeout-ms',
  );
  const attempts = positiveInteger(argument('attempts') ?? '3', 'attempts');
  const capturedAt = new Date().toISOString();

  await mkdir(outputDirectory, { recursive: true });
  process.stdout.write(`capturing Understat ${league} ${season} from ${baseUrl}\n`);
  process.stdout.write(`output: ${outputDirectory}\n`);

  const leaguePath = `/getLeagueData/${encodeURIComponent(league)}/${sourceYear}`;
  const leagueBody = await fetchRaw(baseUrl, leaguePath, timeoutMilliseconds, attempts);
  await Bun.write(`${outputDirectory}/league.json`, leagueBody);
  const leagueJson = asRecord(JSON.parse(leagueBody), 'root');
  const teamsObject = asRecord(leagueJson.teams, 'teams');
  const dates = Array.isArray(leagueJson.dates) ? leagueJson.dates : [];
  const teamInputs = Object.entries(teamsObject).map(([key, value]) => {
    const team = asRecord(value, `teams.${key}`);
    const id = positiveId(team.id ?? key, `team ${key} id`);
    const title = typeof team.title === 'string' && team.title.length > 0 ? team.title : null;
    if (!title) throw new Error(`Understat team ${id} has no title`);
    return {
      baseUrl,
      outputDirectory,
      kind: 'team' as const,
      id: String(id),
      path: `/getTeamData/${encodeURIComponent(title)}/${sourceYear}`,
      file: `team-${id}.json`,
      timeoutMilliseconds,
      attempts,
    };
  });
  const matchIds = [
    ...new Set(
      dates.map((date, index) =>
        positiveId(asRecord(date, `dates.${index}`).id, `match ${index} id`),
      ),
    ),
  ].sort((left, right) => left - right);
  if (teamInputs.length !== 20) {
    throw new Error(`Expected 20 Understat teams, found ${teamInputs.length}`);
  }
  if (dates.length !== 380 || matchIds.length !== 380) {
    throw new Error(
      `Expected 380 unique Understat matches, found dates=${dates.length} unique=${matchIds.length}`,
    );
  }

  const teamResult = await capturePool(teamInputs, concurrency);
  const matchResult = await capturePool(
    matchIds.map((matchId) => ({
      baseUrl,
      outputDirectory,
      kind: 'match' as const,
      id: String(matchId),
      path: `/getMatchData/${matchId}`,
      file: `match-${matchId}.json`,
      timeoutMilliseconds,
      attempts,
    })),
    concurrency,
  );
  const files: RawFileRecord[] = [
    {
      kind: 'league' as const,
      id: league,
      path: leaguePath,
      file: 'league.json',
      bytes: new TextEncoder().encode(leagueBody).byteLength,
      sha256: await sha256(leagueBody),
    },
    ...teamResult.records,
    ...matchResult.records,
  ].sort((left, right) => left.file.localeCompare(right.file));
  const failures = [...teamResult.failures, ...matchResult.failures].sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
  );
  const manifest: RawCaptureManifest = {
    schemaVersion: 1,
    provider: 'understat',
    league,
    season,
    sourceYear,
    capturedAt,
    baseUrl,
    status: failures.length === 0 ? 'complete' : 'failed',
    counts: {
      expected: { league: 1, teams: teamInputs.length, matches: matchIds.length },
      captured: {
        league: 1,
        teams: teamResult.records.length,
        matches: matchResult.records.length,
      },
    },
    files,
    failures,
  };
  await Bun.write(`${outputDirectory}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`manifest: ${outputDirectory}/manifest.json\n`);
  process.stdout.write(`captured files: ${files.length}; failures: ${failures.length}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

await main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
