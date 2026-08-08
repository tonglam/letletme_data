/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import postgres from 'postgres';

import { isTransactionPoolerConnection } from '../src/db/postgres-connection';

const season = getOption('season') ?? '2425';
const shouldApply = process.argv.includes('--apply');
const importedAt = new Date().toISOString();
const databaseUrl = process.env.DATABASE_URL;
const repositoryRoot = process.env.FPL_VAASTAV_REPO_DIR;
const sourceDir =
  process.env.FPL_VAASTAV_SOURCE_DIR ??
  (repositoryRoot ? join(repositoryRoot, 'data', seasonDirectory(season)) : undefined);

const EVENT_COUNT = 38;
const TEAM_COUNT = 20;
const FIXTURE_COUNT = 380;
const INSERT_BATCH_SIZE = 500;
const PLAYER_ID_MULTIPLIER = 100_000;
const EVENT_LIVE_SUMMARY_FIELDS = [
  'minutes',
  'goals_scored',
  'assists',
  'clean_sheets',
  'goals_conceded',
  'own_goals',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'bonus',
  'bps',
  'total_points',
] as const;

type LegacyTeamMetadata = Readonly<{ name: string; shortName: string }>;

// Vaastav's 2016/17 and 2017/18 snapshots do not include teams.csv or raw.json.
// Their players_raw.csv still preserves the official FPL team code, which is
// stable enough to restore the historical display names without placeholders.
const LEGACY_TEAM_METADATA: Readonly<Record<string, Readonly<Record<number, LegacyTeamMetadata>>>> =
  {
    '1617': {
      1: { name: 'Man Utd', shortName: 'MUN' },
      3: { name: 'Arsenal', shortName: 'ARS' },
      6: { name: 'Spurs', shortName: 'TOT' },
      8: { name: 'Chelsea', shortName: 'CHE' },
      11: { name: 'Everton', shortName: 'EVE' },
      13: { name: 'Leicester', shortName: 'LEI' },
      14: { name: 'Liverpool', shortName: 'LIV' },
      20: { name: 'Southampton', shortName: 'SOU' },
      21: { name: 'West Ham', shortName: 'WHU' },
      25: { name: 'Middlesbrough', shortName: 'MID' },
      31: { name: 'Crystal Palace', shortName: 'CRY' },
      35: { name: 'West Brom', shortName: 'WBA' },
      43: { name: 'Man City', shortName: 'MCI' },
      56: { name: 'Sunderland', shortName: 'SUN' },
      57: { name: 'Watford', shortName: 'WAT' },
      80: { name: 'Swansea', shortName: 'SWA' },
      88: { name: 'Hull City', shortName: 'HUL' },
      90: { name: 'Burnley', shortName: 'BUR' },
      91: { name: 'Bournemouth', shortName: 'BOU' },
      110: { name: 'Stoke City', shortName: 'STK' },
    },
    '1718': {
      1: { name: 'Man Utd', shortName: 'MUN' },
      3: { name: 'Arsenal', shortName: 'ARS' },
      4: { name: 'Newcastle', shortName: 'NEW' },
      6: { name: 'Spurs', shortName: 'TOT' },
      8: { name: 'Chelsea', shortName: 'CHE' },
      11: { name: 'Everton', shortName: 'EVE' },
      13: { name: 'Leicester', shortName: 'LEI' },
      14: { name: 'Liverpool', shortName: 'LIV' },
      20: { name: 'Southampton', shortName: 'SOU' },
      21: { name: 'West Ham', shortName: 'WHU' },
      31: { name: 'Crystal Palace', shortName: 'CRY' },
      35: { name: 'West Brom', shortName: 'WBA' },
      36: { name: 'Brighton', shortName: 'BHA' },
      38: { name: 'Huddersfield', shortName: 'HUD' },
      43: { name: 'Man City', shortName: 'MCI' },
      57: { name: 'Watford', shortName: 'WAT' },
      80: { name: 'Swansea', shortName: 'SWA' },
      90: { name: 'Burnley', shortName: 'BUR' },
      91: { name: 'Bournemouth', shortName: 'BOU' },
      110: { name: 'Stoke City', shortName: 'STK' },
    },
  };

const HISTORY_TABLES = [
  'events_history',
  'teams_history',
  'players_history',
  'phases_history',
  'event_fixtures_history',
  'player_stats_history',
  'event_lives_history',
  'event_live_explains_history',
  'event_live_summaries_history',
  'player_values_history',
  'player_market_snapshots_history',
  'fpl_player_fixture_stats_history',
] as const;

const ARCHIVE_ITEMS = [
  ['events', 'events_history'],
  ['teams', 'teams_history'],
  ['players', 'players_history'],
  ['phases', 'phases_history'],
  ['event_fixtures', 'event_fixtures_history'],
  ['player_stats', 'player_stats_history'],
  ['event_lives', 'event_lives_history'],
  ['event_live_explains', 'event_live_explains_history'],
  ['event_live_summaries', 'event_live_summaries_history'],
  ['player_values', 'player_values_history'],
  ['player_market_snapshots', 'player_market_snapshots_history'],
  ['fpl_player_fixture_stats', 'fpl_player_fixture_stats_history'],
] as const;

type CsvRecord = Record<string, string>;
type Row = Record<string, unknown>;
type SqlExecutor = {
  unsafe: (query: string, values?: unknown[]) => Promise<unknown>;
};

interface PlayerSource {
  id: number;
  code: number;
  type: number;
  teamId: number;
  startPrice: number;
  raw: CsvRecord;
}

interface TeamSource {
  id: number;
  code: number;
  raw: CsvRecord;
}

interface FixtureSource {
  id: number;
  code: number;
  sourceEventId: number;
  eventId: number;
  teamAId: number;
  teamHId: number;
  raw: CsvRecord;
}

interface GameweekRow {
  eventId: number;
  raw: CsvRecord;
}

interface SourceGameweekFile {
  sourceEventId: number;
  targetEventId: number;
  rows: CsvRecord[];
}

interface Aggregate {
  eventId: number;
  elementId: number;
  rows: GameweekRow[];
  latest: GameweekRow;
  minutes: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  bps: number;
  starts: number;
  totalPoints: number;
  influence: number;
  creativity: number;
  threat: number;
  ictIndex: number;
  expectedGoals: number;
  expectedAssists: number;
  expectedGoalInvolvements: number;
  expectedGoalsConceded: number;
}

interface MarketState {
  value: number;
  selected: number;
  transfersIn: number;
  transfersOut: number;
  transfersInEvent: number;
  transfersOutEvent: number;
  teamId: number;
  observed: boolean;
}

interface ArchiveRows {
  events: Row[];
  teams: Row[];
  players: Row[];
  phases: Row[];
  eventFixtures: Row[];
  playerStats: Row[];
  eventLives: Row[];
  eventLiveExplains: Row[];
  eventLiveSummaries: Row[];
  playerValues: Row[];
  playerMarketSnapshots: Row[];
  playerFixtureStats: Row[];
}

function getOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function seasonDirectory(value: string): string {
  if (!/^\d{4}$/.test(value)) throw new Error(`Invalid season ${value}`);
  const startYear = 2000 + Number(value.slice(0, 2));
  return `${startYear}-${value.slice(2)}`;
}

function targetEventIdForSourceEvent(sourceEventId: number): number {
  return season === '1920' && sourceEventId >= 39 && sourceEventId <= 47
    ? sourceEventId - 9
    : sourceEventId;
}

function sourceGameweekIds(): number[] {
  if (season === '1920') {
    return [
      ...Array.from({ length: 29 }, (_, index) => index + 1),
      ...Array.from({ length: 9 }, (_, index) => index + 39),
    ];
  }
  return Array.from({ length: EVENT_COUNT }, (_, index) => index + 1);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((value) => value !== '')) rows.push(row);
  }
  return rows;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readCsv(relativePath: string): Promise<CsvRecord[]> {
  if (!sourceDir) {
    throw new Error('FPL_VAASTAV_SOURCE_DIR or FPL_VAASTAV_REPO_DIR is required');
  }
  const rows = parseCsv(await Bun.file(join(sourceDir, relativePath)).text());
  const headers = rows.shift();
  if (!headers || headers.length === 0) throw new Error(`CSV has no header: ${relativePath}`);
  return rows.map((values, rowIndex) => {
    const record: CsvRecord = {};
    for (const [index, header] of headers.entries()) record[header] = values[index] ?? '';
    if (Object.keys(record).length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has an invalid width: ${relativePath}`);
    }
    return record;
  });
}

async function readTeams(rawPlayers: readonly CsvRecord[]): Promise<CsvRecord[]> {
  if (!sourceDir) throw new Error('FPL_VAASTAV_SOURCE_DIR or FPL_VAASTAV_REPO_DIR is required');
  const csvFile = Bun.file(join(sourceDir, 'teams.csv'));
  if (await csvFile.exists()) return readCsv('teams.csv');
  const jsonFile = Bun.file(join(sourceDir, 'raw.json'));
  if (await jsonFile.exists()) {
    const parsed = JSON.parse(await jsonFile.text()) as { teams?: unknown };
    if (!Array.isArray(parsed.teams) || !parsed.teams.every(isObjectRecord)) {
      throw new Error('raw.json has no usable teams array');
    }
    return parsed.teams.map((team) => {
      const record: CsvRecord = {};
      for (const [key, value] of Object.entries(team))
        record[key] = value === null || value === undefined ? '' : String(value);
      return record;
    });
  }
  const teams = new Map<number, CsvRecord>();
  for (const player of rawPlayers) {
    const id = csvInteger(player.team, 'player.team');
    const code = csvInteger(player.team_code, `team ${id} team_code`);
    const metadata = LEGACY_TEAM_METADATA[season]?.[code];
    const existing = teams.get(id);
    if (existing && csvInteger(existing.code, `team ${id} code`) !== code)
      throw new Error(`Team ${id} has inconsistent team_code in players_raw.csv`);
    teams.set(id, {
      id: String(id),
      code: String(code),
      name: metadata?.name ?? `Team ${id}`,
      short_name: metadata?.shortName ?? `T${id}`,
      pulse_id: String(code),
    });
  }
  return [...teams.values()];
}

async function readGameweekSources(): Promise<SourceGameweekFile[]> {
  const files: SourceGameweekFile[] = [];
  for (const sourceEventId of sourceGameweekIds()) {
    files.push({
      sourceEventId,
      targetEventId: targetEventIdForSourceEvent(sourceEventId),
      rows: await readCsv(join('gws', `gw${sourceEventId}.csv`)),
    });
  }
  return files;
}

function deriveFixtures(gameweekSources: readonly SourceGameweekFile[]): FixtureSource[] {
  const rowsByFixture = new Map<number, { sourceEventId: number; rows: CsvRecord[] }>();
  for (const source of gameweekSources) {
    for (const raw of source.rows) {
      const id = csvInteger(raw.fixture, `GW${source.sourceEventId} fixture`);
      const existing = rowsByFixture.get(id);
      if (!existing) rowsByFixture.set(id, { sourceEventId: source.targetEventId, rows: [raw] });
      else if (existing.sourceEventId !== source.targetEventId)
        throw new Error(`Fixture ${id} appears in multiple gameweeks`);
      else existing.rows.push(raw);
    }
  }
  return [...rowsByFixture.entries()].map(([id, occurrence]) => {
    const homeOpponentIds = new Set<number>();
    const awayOpponentIds = new Set<number>();
    for (const raw of occurrence.rows) {
      const opponent = csvInteger(raw.opponent_team, `fixture ${id} opponent_team`);
      if (csvBoolean(raw.was_home, `fixture ${id} was_home`)) awayOpponentIds.add(opponent);
      else homeOpponentIds.add(opponent);
    }
    if (homeOpponentIds.size !== 1 || awayOpponentIds.size !== 1) {
      throw new Error(`Fixture ${id} cannot derive both teams from gameweek rows`);
    }
    const first = occurrence.rows[0];
    const code = id;
    const raw: CsvRecord = {
      id: String(id),
      code: String(code),
      event: String(occurrence.sourceEventId),
      kickoff_time: csvString(first.kickoff_time, `fixture ${id} kickoff_time`),
      started: 'True',
      finished: 'True',
      finished_provisional: 'True',
      minutes: '90',
      provisional_start_time: 'False',
      team_a: String([...awayOpponentIds][0]),
      team_h: String([...homeOpponentIds][0]),
      team_a_score: csvString(first.team_a_score, `fixture ${id} team_a_score`),
      team_h_score: csvString(first.team_h_score, `fixture ${id} team_h_score`),
      team_a_difficulty: '',
      team_h_difficulty: '',
      stats: '[]',
      pulse_id: String(code),
    };
    return {
      id,
      code,
      sourceEventId: occurrence.sourceEventId,
      eventId: occurrence.sourceEventId,
      teamAId: [...awayOpponentIds][0],
      teamHId: [...homeOpponentIds][0],
      raw,
    };
  });
}

function csvNumber(value: string | undefined, label: string, fallback = 0): number {
  if (value === undefined || value.trim() === '' || value === 'None') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected number for ${label}: ${value}`);
  return parsed;
}

function csvInteger(value: string | undefined, label: string, fallback = 0): number {
  const parsed = csvNumber(value, label, fallback);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer for ${label}: ${parsed}`);
  return parsed;
}

function buildSeasonEventLiveSummaries(
  season: string,
  eventLivesRows: readonly Row[],
  playersById: Map<number, PlayerSource>,
  importedAt: string,
): Row[] {
  const summariesByElement = new Map<number, Row>();
  for (const eventLive of eventLivesRows) {
    const elementId = Number(eventLive.element_id);
    const player = playersById.get(elementId);
    if (!player) throw new Error(`Event live references unknown player ${elementId}`);

    let summary = summariesByElement.get(elementId);
    if (!summary) {
      summary = {
        season,
        id: elementId,
        element_id: elementId,
        element_type: player.type,
        created_at: importedAt,
        updated_at: importedAt,
      };
      for (const field of EVENT_LIVE_SUMMARY_FIELDS) summary[field] = 0;
      summariesByElement.set(elementId, summary);
    }

    for (const field of EVENT_LIVE_SUMMARY_FIELDS) {
      summary[field] = Number(summary[field] ?? 0) + Number(eventLive[field] ?? 0);
    }
  }

  return [...summariesByElement.values()].sort(
    (left, right) => Number(left.element_id) - Number(right.element_id),
  );
}

function csvNonNegativeInteger(value: string | undefined, label: string, fallback = 0): number {
  const parsed = csvInteger(value, label, fallback);
  if (parsed < 0) throw new Error(`Expected non-negative integer for ${label}: ${parsed}`);
  return parsed;
}

function csvBoolean(value: string | undefined, label: string, fallback = false): boolean {
  if (value === undefined || value === '' || value === 'None') return fallback;
  if (value === 'True' || value === 'true' || value === '1') return true;
  if (value === 'False' || value === 'false' || value === '0') return false;
  throw new Error(`Expected boolean for ${label}: ${value}`);
}

function csvString(value: string | undefined, label: string, fallback = ''): string {
  if (value === undefined || value === 'None') return fallback;
  return value;
}

function csvNullableString(value: string | undefined): string | null {
  return value === undefined || value === '' || value === 'None' ? null : value;
}

function csvJson(value: string | undefined): string {
  if (!value || value === 'None') return '[]';
  try {
    const normalized = value
      .replace(/\bNone\b/g, 'null')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replaceAll(/'/g, '"');
    JSON.parse(normalized);
    return normalized;
  } catch {
    return '[]';
  }
}

function dateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) throw new Error(`Expected ISO date: ${value}`);
  return value.slice(0, 10);
}

function dateKey(value: string): string {
  return dateOnly(value).replaceAll('-', '');
}

function positionForType(type: number): string {
  return ({ 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' } as Record<number, string>)[type] ?? 'UNK';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function contentHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function createAggregate(eventId: number, elementId: number, rows: GameweekRow[]): Aggregate {
  const sortedRows = [...rows].sort((left, right) => {
    const leftTime = Date.parse(csvString(left.raw.kickoff_time, 'kickoff_time'));
    const rightTime = Date.parse(csvString(right.raw.kickoff_time, 'kickoff_time'));
    return (
      leftTime - rightTime ||
      csvInteger(left.raw.fixture, 'fixture') - csvInteger(right.raw.fixture, 'fixture')
    );
  });
  const sum = (field: string): number =>
    rows.reduce((total, row) => total + csvNumber(row.raw[field], `${field} event ${eventId}`), 0);
  return {
    eventId,
    elementId,
    rows,
    latest: sortedRows[sortedRows.length - 1],
    minutes: sum('minutes'),
    goalsScored: sum('goals_scored'),
    assists: sum('assists'),
    cleanSheets: sum('clean_sheets'),
    goalsConceded: sum('goals_conceded'),
    ownGoals: sum('own_goals'),
    penaltiesSaved: sum('penalties_saved'),
    penaltiesMissed: sum('penalties_missed'),
    yellowCards: sum('yellow_cards'),
    redCards: sum('red_cards'),
    saves: sum('saves'),
    bonus: sum('bonus'),
    bps: sum('bps'),
    starts: sum('starts'),
    totalPoints: sum('total_points'),
    influence: sum('influence'),
    creativity: sum('creativity'),
    threat: sum('threat'),
    ictIndex: sum('ict_index'),
    expectedGoals: sum('expected_goals'),
    expectedAssists: sum('expected_assists'),
    expectedGoalInvolvements: sum('expected_goal_involvements'),
    expectedGoalsConceded: sum('expected_goals_conceded'),
  };
}

function aggregateValue(aggregate: Aggregate, field: keyof Aggregate): number {
  const value = aggregate[field];
  return typeof value === 'number' ? value : 0;
}

function loadMarketState(
  player: PlayerSource,
  eventId: number,
  aggregate: Aggregate | undefined,
  fixturesById: Map<number, FixtureSource>,
  prior: MarketState,
): MarketState {
  if (!aggregate) {
    return {
      ...prior,
      transfersInEvent: 0,
      transfersOutEvent: 0,
      observed: false,
    };
  }
  const latest = aggregate.latest.raw;
  const fixtureId = csvInteger(latest.fixture, `player ${player.id} fixture`);
  const fixture = fixturesById.get(fixtureId);
  if (!fixture) throw new Error(`Unknown fixture ${fixtureId} for player ${player.id}`);
  const teamId = csvBoolean(latest.was_home, `player ${player.id} was_home`)
    ? fixture.teamHId
    : fixture.teamAId;
  const transfersInEvent = csvNonNegativeInteger(
    latest.transfers_in,
    `player ${player.id} event ${eventId} transfers_in`,
  );
  const transfersOutEvent = csvNonNegativeInteger(
    latest.transfers_out,
    `player ${player.id} event ${eventId} transfers_out`,
  );
  return {
    value: csvNonNegativeInteger(latest.value, `player ${player.id} event ${eventId} value`),
    selected: csvNonNegativeInteger(
      latest.selected,
      `player ${player.id} event ${eventId} selected`,
    ),
    transfersIn: prior.transfersIn + transfersInEvent,
    transfersOut: prior.transfersOut + transfersOutEvent,
    transfersInEvent,
    transfersOutEvent,
    teamId,
    observed: true,
  };
}

function selectedPercent(player: PlayerSource, eventId: number): number {
  // Vaastav preserves selected manager counts but not each GW's ranked_count.
  // Only the final players_raw snapshot has an official percentage.
  return eventId === EVENT_COUNT
    ? csvNumber(player.raw.selected_by_percent, 'selected_by_percent')
    : 0;
}

function buildRows(
  players: PlayerSource[],
  teams: TeamSource[],
  fixtures: FixtureSource[],
  gameweeks: GameweekRow[],
): ArchiveRows {
  const playersById = new Map(players.map((player) => [player.id, player]));
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const rowsByEvent = new Map<number, Map<number, GameweekRow[]>>();
  for (const row of gameweeks) {
    const elementId = csvInteger(row.raw.element, `GW${row.eventId} element`);
    if (!playersById.has(elementId))
      throw new Error(`GW${row.eventId} references unknown player ${elementId}`);
    const fixtureId = csvInteger(row.raw.fixture, `GW${row.eventId} fixture`);
    const fixture = fixturesById.get(fixtureId);
    if (!fixture || fixture.eventId !== row.eventId) {
      throw new Error(`GW${row.eventId} row references fixture ${fixtureId} from another event`);
    }
    const eventRows = rowsByEvent.get(row.eventId) ?? new Map<number, GameweekRow[]>();
    const playerRows = eventRows.get(elementId) ?? [];
    playerRows.push(row);
    eventRows.set(elementId, playerRows);
    rowsByEvent.set(row.eventId, eventRows);
  }

  const aggregatesByEvent = new Map<number, Map<number, Aggregate>>();
  for (let eventId = 1; eventId <= EVENT_COUNT; eventId += 1) {
    const aggregateMap = new Map<number, Aggregate>();
    for (const [elementId, rows] of rowsByEvent.get(eventId) ?? []) {
      aggregateMap.set(elementId, createAggregate(eventId, elementId, rows));
    }
    aggregatesByEvent.set(eventId, aggregateMap);
  }

  // Vaastav's season CSV contains almost all final corrections, but one
  // 2024/25 player differs from the sum of the GW rows. Reconcile the final
  // event to the season-final player snapshot and keep the correction visible
  // in final cumulative stats/live, rather than silently reporting the stale
  // GW sum as final truth.
  const reconciledFields: Array<[keyof Aggregate, string]> = [
    ['minutes', 'minutes'],
    ['goalsScored', 'goals_scored'],
    ['assists', 'assists'],
    ['cleanSheets', 'clean_sheets'],
    ['goalsConceded', 'goals_conceded'],
    ['ownGoals', 'own_goals'],
    ['penaltiesSaved', 'penalties_saved'],
    ['yellowCards', 'yellow_cards'],
    ['redCards', 'red_cards'],
    ['saves', 'saves'],
    ['bonus', 'bonus'],
    ['bps', 'bps'],
    ['starts', 'starts'],
    ['totalPoints', 'total_points'],
  ];
  const finalAggregates = aggregatesByEvent.get(EVENT_COUNT);
  if (!finalAggregates) throw new Error('Missing final gameweek aggregates');
  for (const player of players) {
    const final = finalAggregates.get(player.id);
    if (!final) throw new Error(`Final GW has no row for player ${player.id}`);
    const cumulative = new Map<keyof Aggregate, number>();
    for (const [field] of reconciledFields) cumulative.set(field, 0);
    for (const aggregateMap of aggregatesByEvent.values()) {
      const aggregate = aggregateMap.get(player.id);
      if (!aggregate) continue;
      for (const [field] of reconciledFields) {
        cumulative.set(field, (cumulative.get(field) ?? 0) + aggregateValue(aggregate, field));
      }
    }
    for (const [field, csvField] of reconciledFields) {
      const expected = csvNumber(player.raw[csvField], `player ${player.id} ${csvField}`);
      const difference = expected - (cumulative.get(field) ?? 0);
      if (difference !== 0) {
        (final[field] as number) += difference;
      }
    }
  }

  const eventDeadline = new Map<number, string>();
  for (const fixture of fixtures) {
    const kickoff = csvString(fixture.raw.kickoff_time, `fixture ${fixture.id} kickoff_time`);
    const prior = eventDeadline.get(fixture.eventId);
    if (!prior || Date.parse(kickoff) < Date.parse(prior))
      eventDeadline.set(fixture.eventId, kickoff);
  }
  const eventsRows: Row[] = Array.from({ length: EVENT_COUNT }, (_, index) => {
    const eventId = index + 1;
    const deadline = eventDeadline.get(eventId) ?? null;
    return {
      season,
      id: eventId,
      name: `Gameweek ${eventId}`,
      deadline_time: deadline,
      average_entry_score: null,
      finished: true,
      data_checked: true,
      highest_scoring_entry: null,
      deadline_time_epoch: deadline === null ? null : Math.floor(Date.parse(deadline) / 1000),
      deadline_time_game_offset: 0,
      highest_score: null,
      is_previous: false,
      is_current: false,
      is_next: false,
      cup_league_create: false,
      h2h_ko_matches_created: false,
      chip_plays: '[]',
      most_selected: null,
      most_transferred_in: null,
      top_element: null,
      top_element_info: null,
      transfers_made: null,
      most_captained: null,
      most_vice_captained: null,
      created_at: importedAt,
      updated_at: importedAt,
      live_snapshot_checked_at: importedAt,
      live_snapshot_finalized_at: importedAt,
    };
  });

  const teamStandings = new Map<
    number,
    {
      played: number;
      win: number;
      draw: number;
      loss: number;
      points: number;
      gf: number;
      ga: number;
    }
  >();
  for (const team of teams)
    teamStandings.set(team.id, { played: 0, win: 0, draw: 0, loss: 0, points: 0, gf: 0, ga: 0 });
  for (const fixture of fixtures) {
    const homeScore = csvInteger(fixture.raw.team_h_score, `fixture ${fixture.id} team_h_score`);
    const awayScore = csvInteger(fixture.raw.team_a_score, `fixture ${fixture.id} team_a_score`);
    const home = teamStandings.get(fixture.teamHId);
    const away = teamStandings.get(fixture.teamAId);
    if (!home || !away) throw new Error(`Fixture ${fixture.id} references unknown standings team`);
    home.played += 1;
    away.played += 1;
    home.gf += homeScore;
    home.ga += awayScore;
    away.gf += awayScore;
    away.ga += homeScore;
    if (homeScore > awayScore) {
      home.win += 1;
      home.points += 3;
      away.loss += 1;
    } else if (homeScore < awayScore) {
      away.win += 1;
      away.points += 3;
      home.loss += 1;
    } else {
      home.draw += 1;
      away.draw += 1;
      home.points += 1;
      away.points += 1;
    }
  }
  const positions = [...teamStandings.entries()]
    .sort(
      (left, right) =>
        right[1].points - left[1].points ||
        right[1].gf - right[1].ga - (left[1].gf - left[1].ga) ||
        right[1].gf - left[1].gf ||
        left[0] - right[0],
    )
    .map(([teamId], index) => [teamId, index + 1] as const);
  const positionByTeam = new Map(positions);

  const teamsRows: Row[] = teams.map(({ id, code, raw }) => {
    const standings = teamStandings.get(id)!;
    return {
      season,
      id,
      code,
      name: csvString(raw.name, `team ${id} name`),
      short_name: csvString(raw.short_name, `team ${id} short_name`),
      strength: raw.strength === '' ? null : csvNumber(raw.strength, `team ${id} strength`),
      position: positionByTeam.get(id) ?? 0,
      points: standings.points,
      win: standings.win,
      draw: standings.draw,
      loss: standings.loss,
      created_at: importedAt,
      played: standings.played,
      form: csvNullableString(raw.form),
      team_division:
        raw.team_division === '' ? null : csvInteger(raw.team_division, 'team_division'),
      unavailable: csvBoolean(raw.unavailable, `team ${id} unavailable`),
      strength_overall_home: csvInteger(raw.strength_overall_home, 'strength_overall_home'),
      strength_overall_away: csvInteger(raw.strength_overall_away, 'strength_overall_away'),
      strength_attack_home: csvInteger(raw.strength_attack_home, 'strength_attack_home'),
      strength_attack_away: csvInteger(raw.strength_attack_away, 'strength_attack_away'),
      strength_defence_home: csvInteger(raw.strength_defence_home, 'strength_defence_home'),
      strength_defence_away: csvInteger(raw.strength_defence_away, 'strength_defence_away'),
      pulse_id:
        raw.pulse_id === undefined || raw.pulse_id === ''
          ? code
          : csvInteger(raw.pulse_id, `team ${id} pulse_id`),
      updated_at: importedAt,
    };
  });

  const playersRows: Row[] = players.map(({ id, code, type, teamId, startPrice, raw }) => ({
    season,
    id,
    code,
    type,
    team_id: teamId,
    price: csvNonNegativeInteger(raw.now_cost, `player ${id} now_cost`),
    start_price: startPrice,
    first_name: csvNullableString(raw.first_name),
    second_name: csvNullableString(raw.second_name),
    web_name: csvString(raw.web_name, `player ${id} web_name`),
    created_at: importedAt,
    updated_at: importedAt,
    total_points: csvNumber(raw.total_points, `player ${id} total_points`),
    price_source_checked_at: importedAt,
  }));

  const phasesRows: Row[] = [
    {
      season,
      id: 1,
      name: 'Overall',
      start_event: 1,
      stop_event: EVENT_COUNT,
      highest_score: null,
      created_at: importedAt,
      updated_at: importedAt,
    },
  ];

  const eventFixturesRows: Row[] = fixtures.map(({ id, code, eventId, teamAId, teamHId, raw }) => ({
    season,
    id,
    code,
    event_id: eventId,
    kickoff_time: csvString(raw.kickoff_time, `fixture ${id} kickoff_time`),
    started: csvBoolean(raw.started, `fixture ${id} started`),
    finished: csvBoolean(raw.finished, `fixture ${id} finished`),
    minutes: csvInteger(raw.minutes, `fixture ${id} minutes`),
    team_h_id: teamHId,
    team_h_difficulty: csvNumber(raw.team_h_difficulty, 'team_h_difficulty'),
    team_h_score: csvInteger(raw.team_h_score, `fixture ${id} team_h_score`),
    team_a_id: teamAId,
    team_a_difficulty: csvNumber(raw.team_a_difficulty, 'team_a_difficulty'),
    team_a_score: csvInteger(raw.team_a_score, `fixture ${id} team_a_score`),
    created_at: importedAt,
    finished_provisional: csvBoolean(
      raw.finished_provisional,
      `fixture ${id} finished_provisional`,
    ),
    provisional_start_time: csvBoolean(
      raw.provisional_start_time,
      `fixture ${id} provisional_start_time`,
    ),
    stats: csvJson(raw.stats),
    pulse_id:
      raw.pulse_id === undefined || raw.pulse_id === ''
        ? code
        : csvInteger(raw.pulse_id, `fixture ${id} pulse_id`),
    updated_at: importedAt,
  }));

  const eventLivesRows: Row[] = [];
  const eventLiveExplainsRows: Row[] = [];
  const playerStatsRows: Row[] = [];
  const eventLiveSummariesRows: Row[] = [];
  const playerValuesRows: Row[] = [];
  const playerMarketSnapshotsRows: Row[] = [];
  const playerFixtureStatsRows: Row[] = [];
  const priorMarket = new Map<number, MarketState>();
  const cumulative = new Map<number, Aggregate>();

  for (const player of players) {
    priorMarket.set(player.id, {
      value: startPriceFor(player),
      selected: 0,
      transfersIn: 0,
      transfersOut: 0,
      transfersInEvent: 0,
      transfersOutEvent: 0,
      teamId: player.teamId,
      observed: false,
    });
  }

  for (let eventId = 1; eventId <= EVENT_COUNT; eventId += 1) {
    const deadline = eventDeadline.get(eventId)!;
    for (const [elementId, aggregate] of [...(aggregatesByEvent.get(eventId) ?? [])].sort(
      ([left], [right]) => left - right,
    )) {
      const player = playersById.get(elementId);
      if (!player) throw new Error(`Missing player ${elementId}`);
      const previousMarket = priorMarket.get(elementId)!;
      const market = loadMarketState(player, eventId, aggregate, fixturesById, previousMarket);
      priorMarket.set(elementId, market);
      const selectedPercent = selectedPercentFor(player, eventId);
      eventLivesRows.push({
        season,
        id: eventId * PLAYER_ID_MULTIPLIER + elementId,
        event_id: eventId,
        element_id: elementId,
        minutes: aggregate.minutes,
        goals_scored: aggregate.goalsScored,
        assists: aggregate.assists,
        clean_sheets: aggregate.cleanSheets,
        goals_conceded: aggregate.goalsConceded,
        own_goals: aggregate.ownGoals,
        penalties_saved: aggregate.penaltiesSaved,
        penalties_missed: aggregate.penaltiesMissed,
        yellow_cards: aggregate.yellowCards,
        red_cards: aggregate.redCards,
        saves: aggregate.saves,
        bonus: aggregate.bonus,
        bps: aggregate.bps,
        starts: aggregate.starts > 0,
        expected_goals: aggregate.expectedGoals,
        expected_assists: aggregate.expectedAssists,
        expected_goal_involvements: aggregate.expectedGoalInvolvements,
        expected_goals_conceded: aggregate.expectedGoalsConceded,
        in_dream_team: false,
        total_points: aggregate.totalPoints,
        created_at: importedAt,
        updated_at: importedAt,
        defensive_contribution: 0,
      });
      eventLiveExplainsRows.push({
        season,
        id: eventId * PLAYER_ID_MULTIPLIER + elementId,
        event_id: eventId,
        element_id: elementId,
        bonus: aggregate.bonus,
        minutes: aggregate.minutes,
        minutes_points: null,
        goals_scored: aggregate.goalsScored,
        goals_scored_points: null,
        assists: aggregate.assists,
        assists_points: null,
        clean_sheets: aggregate.cleanSheets,
        clean_sheets_points: null,
        goals_conceded: aggregate.goalsConceded,
        goals_conceded_points: null,
        own_goals: aggregate.ownGoals,
        own_goals_points: null,
        penalties_saved: aggregate.penaltiesSaved,
        penalties_saved_points: null,
        penalties_missed: aggregate.penaltiesMissed,
        penalties_missed_points: null,
        yellow_cards: aggregate.yellowCards,
        yellow_cards_points: null,
        red_cards: aggregate.redCards,
        red_cards_points: null,
        saves: aggregate.saves,
        saves_points: null,
        created_at: importedAt,
        updated_at: importedAt,
        defensive_contribution: 0,
        defensive_contribution_points: null,
      });

      const prior = cumulative.get(elementId) ?? emptyAggregate(eventId, elementId);
      addAggregate(prior, aggregate);
      cumulative.set(elementId, prior);
      playerStatsRows.push({
        season,
        id: eventId * PLAYER_ID_MULTIPLIER + elementId,
        event_id: eventId,
        element_id: elementId,
        element_type: player.type,
        total_points: prior.totalPoints,
        form: null,
        influence: prior.influence,
        creativity: prior.creativity,
        threat: prior.threat,
        ict_index: prior.ictIndex,
        expected_goals: prior.expectedGoals,
        expected_assists: prior.expectedAssists,
        expected_goal_involvements: prior.expectedGoalInvolvements,
        expected_goals_conceded: prior.expectedGoalsConceded,
        minutes: prior.minutes,
        goals_scored: prior.goalsScored,
        assists: prior.assists,
        clean_sheets: prior.cleanSheets,
        goals_conceded: prior.goalsConceded,
        own_goals: prior.ownGoals,
        penalties_saved: prior.penaltiesSaved,
        yellow_cards: prior.yellowCards,
        red_cards: prior.redCards,
        saves: prior.saves,
        bonus: prior.bonus,
        bps: prior.bps,
        starts: prior.starts,
        influence_rank: null,
        influence_rank_type: null,
        creativity_rank: null,
        creativity_rank_type: null,
        threat_rank: null,
        threat_rank_type: null,
        ict_index_rank: null,
        ict_index_rank_type: null,
        created_at: importedAt,
        updated_at: importedAt,
        transfers_in: market.transfersIn,
        transfers_in_event: market.transfersInEvent,
        transfers_out: market.transfersOut,
        transfers_out_event: market.transfersOutEvent,
        selected_by_percent: selectedPercent.toFixed(1),
      });

      const team = teamsById.get(market.teamId);
      if (!team) throw new Error(`Missing market team ${market.teamId} for player ${elementId}`);
      playerMarketSnapshotsRows.push({
        season,
        id: playerMarketSnapshotsRows.length + 1,
        snapshot_date: dateOnly(deadline),
        captured_at: deadline,
        element_id: elementId,
        player_code: player.code,
        web_name: csvString(player.raw.web_name, `player ${elementId} web_name`),
        first_name: csvString(player.raw.first_name, `player ${elementId} first_name`),
        second_name: csvString(player.raw.second_name, `player ${elementId} second_name`),
        team_id: team.id,
        team_name: csvString(team.raw.name, `team ${team.id} name`),
        team_short_name: csvString(team.raw.short_name, `team ${team.id} short_name`),
        element_type: player.type,
        position: positionForType(player.type),
        price: market.value,
        selected_by_percent: selectedPercent,
        transfers_in: market.transfersIn,
        transfers_out: market.transfersOut,
        transfers_in_event: market.transfersInEvent,
        transfers_out_event: market.transfersOutEvent,
        status: 'unknown',
        news: '',
        news_added: null,
        chance_of_playing_this_round: null,
        chance_of_playing_next_round: null,
      });
    }

    for (const [elementId, aggregate] of aggregatesByEvent.get(eventId) ?? []) {
      const player = playersById.get(elementId)!;
      const state = priorMarket.get(elementId)!;
      const observedValue = csvNonNegativeInteger(
        aggregate.latest.raw.value,
        `player ${elementId} value`,
      );
      const previousValue = latestObservedValue(playerValuesRows, elementId);
      if (previousValue === null) {
        playerValuesRows.push({
          season,
          id: playerValuesRows.length + 1,
          element_id: elementId,
          element_type: player.type,
          event_id: eventId,
          value: observedValue,
          change_date: dateKey(eventDeadline.get(eventId)!),
          last_value: 0,
          created_at: importedAt,
          change_type: 'start',
        });
      } else if (observedValue !== previousValue) {
        playerValuesRows.push({
          season,
          id: playerValuesRows.length + 1,
          element_id: elementId,
          element_type: player.type,
          event_id: eventId,
          value: observedValue,
          change_date: dateKey(eventDeadline.get(eventId)!),
          last_value: previousValue,
          created_at: importedAt,
          change_type: observedValue > previousValue ? 'rise' : 'fall',
        });
      }
      void state;
    }
  }

  eventLiveSummariesRows.push(
    ...buildSeasonEventLiveSummaries(season, eventLivesRows, playersById, importedAt),
  );

  for (const row of gameweeks) {
    const fixtureId = csvInteger(row.raw.fixture, 'fixture stat fixture');
    const fixture = fixturesById.get(fixtureId);
    const elementId = csvInteger(row.raw.element, 'fixture stat element');
    const player = playersById.get(elementId);
    if (!fixture || !player) throw new Error(`Unresolved fixture stat ${fixtureId}/${elementId}`);
    const teamId = csvBoolean(row.raw.was_home, `fixture stat ${fixtureId} was_home`)
      ? fixture.teamHId
      : fixture.teamAId;
    const team = teamsById.get(teamId);
    if (!team) throw new Error(`Unresolved fixture stat team ${teamId}`);
    const base = {
      season,
      eventId: fixture.eventId,
      fixtureId,
      fixtureCode: fixture.code,
      elementId,
      playerCode: player.code,
      teamId,
      teamCode: team.code,
      elementType: player.type,
      minutes: csvNonNegativeInteger(row.raw.minutes, 'fixture stat minutes'),
      starts: csvNonNegativeInteger(row.raw.starts, 'fixture stat starts'),
      goals: csvNonNegativeInteger(row.raw.goals_scored, 'fixture stat goals'),
      assists: csvNonNegativeInteger(row.raw.assists, 'fixture stat assists'),
      ownGoals: csvNonNegativeInteger(row.raw.own_goals, 'fixture stat own_goals'),
      yellowCards: csvNonNegativeInteger(row.raw.yellow_cards, 'fixture stat yellow_cards'),
      redCards: csvNonNegativeInteger(row.raw.red_cards, 'fixture stat red_cards'),
    };
    if (base.starts > 1) throw new Error(`Invalid starts ${base.starts} for fixture ${fixtureId}`);
    playerFixtureStatsRows.push({
      season,
      id: playerFixtureStatsRows.length + 1,
      event_id: base.eventId,
      fixture_id: base.fixtureId,
      fixture_code: base.fixtureCode,
      element_id: base.elementId,
      player_code: base.playerCode,
      team_id: base.teamId,
      team_code: base.teamCode,
      element_type: base.elementType,
      minutes: base.minutes,
      starts: base.starts,
      goals: base.goals,
      assists: base.assists,
      own_goals: base.ownGoals,
      yellow_cards: base.yellowCards,
      red_cards: base.redCards,
      source_hash: contentHash(base),
      created_at: importedAt,
      updated_at: null,
    });
  }

  if (
    eventsRows.length !== EVENT_COUNT ||
    teamsRows.length !== TEAM_COUNT ||
    fixtures.length !== FIXTURE_COUNT
  ) {
    throw new Error('Core source coverage is incomplete');
  }
  if (
    playerStatsRows.length !== eventLivesRows.length ||
    eventLivesRows.length !== eventLiveExplainsRows.length
  ) {
    throw new Error('Derived event row counts diverged');
  }
  const summaryElementIds = new Set(eventLivesRows.map((row) => Number(row.element_id)));
  if (eventLiveSummariesRows.length !== summaryElementIds.size) {
    throw new Error('Season event summary coverage is incomplete');
  }
  if (playerValuesRows.length === 0) throw new Error('No player value rows were produced');

  return {
    events: eventsRows,
    teams: teamsRows,
    players: playersRows,
    phases: phasesRows,
    eventFixtures: eventFixturesRows,
    playerStats: playerStatsRows,
    eventLives: eventLivesRows,
    eventLiveExplains: eventLiveExplainsRows,
    eventLiveSummaries: eventLiveSummariesRows,
    playerValues: playerValuesRows,
    playerMarketSnapshots: playerMarketSnapshotsRows,
    playerFixtureStats: playerFixtureStatsRows,
  };
}

function startPriceFor(player: PlayerSource): number {
  return player.startPrice;
}

function selectedPercentFor(player: PlayerSource, eventId: number): number {
  return selectedPercent(player, eventId);
}

function emptyAggregate(eventId: number, elementId: number): Aggregate {
  return {
    eventId,
    elementId,
    rows: [],
    latest: { eventId, raw: {} },
    minutes: 0,
    goalsScored: 0,
    assists: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    ownGoals: 0,
    penaltiesSaved: 0,
    penaltiesMissed: 0,
    yellowCards: 0,
    redCards: 0,
    saves: 0,
    bonus: 0,
    bps: 0,
    starts: 0,
    totalPoints: 0,
    influence: 0,
    creativity: 0,
    threat: 0,
    ictIndex: 0,
    expectedGoals: 0,
    expectedAssists: 0,
    expectedGoalInvolvements: 0,
    expectedGoalsConceded: 0,
  };
}

type NumericAggregateField = Exclude<keyof Aggregate, 'eventId' | 'elementId' | 'rows' | 'latest'>;

function addAggregate(target: Aggregate, source: Aggregate): void {
  const fields: NumericAggregateField[] = [
    'minutes',
    'goalsScored',
    'assists',
    'cleanSheets',
    'goalsConceded',
    'ownGoals',
    'penaltiesSaved',
    'penaltiesMissed',
    'yellowCards',
    'redCards',
    'saves',
    'bonus',
    'bps',
    'starts',
    'totalPoints',
    'influence',
    'creativity',
    'threat',
    'ictIndex',
    'expectedGoals',
    'expectedAssists',
    'expectedGoalInvolvements',
    'expectedGoalsConceded',
  ];
  for (const field of fields)
    target[field] = aggregateValue(target, field) + aggregateValue(source, field);
}

function latestObservedValue(rows: readonly Row[], elementId: number): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].element_id === elementId) return Number(rows[index].value);
  }
  return null;
}

async function loadSource(): Promise<{
  players: PlayerSource[];
  teams: TeamSource[];
  fixtures: FixtureSource[];
  gameweeks: GameweekRow[];
}> {
  if (season === '2526') throw new Error('Use scripts/backfill-fpl-history.ts for season 2526');
  if (!sourceDir) throw new Error('FPL_VAASTAV_SOURCE_DIR or FPL_VAASTAV_REPO_DIR is required');
  const rawPlayers = await readCsv('players_raw.csv');
  const rawTeams = await readTeams(rawPlayers);
  const players = rawPlayers.map((raw) => {
    const id = csvInteger(raw.id, 'player.id');
    const nowCost = csvNonNegativeInteger(raw.now_cost, `player ${id} now_cost`);
    return {
      id,
      code: csvInteger(raw.code, `player ${id} code`),
      type: csvInteger(raw.element_type, `player ${id} element_type`),
      teamId: csvInteger(raw.team, `player ${id} team`),
      startPrice: nowCost - csvInteger(raw.cost_change_start, `player ${id} cost_change_start`),
      raw,
    };
  });
  const teams = rawTeams.map((raw) => ({
    id: csvInteger(raw.id, 'team.id'),
    code: csvInteger(raw.code, 'team.code'),
    raw,
  }));
  const gameweekSources = await readGameweekSources();
  const fixturesFile = Bun.file(join(sourceDir, 'fixtures.csv'));
  const fixtures = (await fixturesFile.exists())
    ? (await readCsv('fixtures.csv')).map((raw) => {
        const sourceEventId = csvInteger(raw.event, 'fixture.event');
        return {
          id: csvInteger(raw.id, 'fixture.id'),
          code: csvInteger(raw.code, 'fixture.code'),
          sourceEventId,
          eventId: targetEventIdForSourceEvent(sourceEventId),
          teamAId: csvInteger(raw.team_a, 'fixture.team_a'),
          teamHId: csvInteger(raw.team_h, 'fixture.team_h'),
          raw,
        };
      })
    : deriveFixtures(gameweekSources);
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const gameweeks: GameweekRow[] = [];
  for (const source of gameweekSources) {
    for (const raw of source.rows) {
      const fixtureId = csvInteger(raw.fixture, `GW${source.sourceEventId} fixture`);
      const fixture = fixturesById.get(fixtureId);
      if (!fixture)
        throw new Error(`GW${source.sourceEventId} references unknown fixture ${fixtureId}`);
      if (fixture.sourceEventId !== source.sourceEventId) {
        if (season === '1920') continue;
        throw new Error(
          `GW${source.sourceEventId} row references fixture ${fixtureId} from source event ${fixture.sourceEventId}`,
        );
      }
      gameweeks.push({ eventId: source.targetEventId, raw });
    }
  }
  if (teams.length !== TEAM_COUNT || fixtures.length !== FIXTURE_COUNT || players.length === 0) {
    throw new Error(
      `Unexpected source coverage: teams=${teams.length}, fixtures=${fixtures.length}, players=${players.length}`,
    );
  }
  return { players, teams, fixtures, gameweeks };
}

function valuesForRows(rows: readonly Row[], columns: readonly string[]): unknown[] {
  return rows.flatMap((row) => columns.map((column) => row[column] ?? null));
}

async function insertRows(
  tx: SqlExecutor,
  table: string,
  columns: readonly string[],
  rows: readonly Row[],
): Promise<void> {
  if (rows.length === 0) return;
  const columnSql = columns.map((column) => `"${column}"`).join(', ');
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    let placeholder = 1;
    const placeholders = chunk.map(() => `(${columns.map(() => `$${placeholder++}`).join(', ')})`);
    await tx.unsafe(
      `INSERT INTO public."${table}" (${columnSql}) VALUES ${placeholders.join(', ')}`,
      valuesForRows(chunk, columns),
    );
  }
}

function rowsByTable(rows: ArchiveRows): Array<[string, readonly string[], readonly Row[]]> {
  return [
    [
      'events_history',
      [
        'season',
        'id',
        'name',
        'deadline_time',
        'average_entry_score',
        'finished',
        'data_checked',
        'highest_scoring_entry',
        'deadline_time_epoch',
        'deadline_time_game_offset',
        'highest_score',
        'is_previous',
        'is_current',
        'is_next',
        'cup_league_create',
        'h2h_ko_matches_created',
        'chip_plays',
        'most_selected',
        'most_transferred_in',
        'top_element',
        'top_element_info',
        'transfers_made',
        'most_captained',
        'most_vice_captained',
        'created_at',
        'updated_at',
        'live_snapshot_checked_at',
        'live_snapshot_finalized_at',
      ],
      rows.events,
    ],
    [
      'teams_history',
      [
        'season',
        'id',
        'code',
        'name',
        'short_name',
        'strength',
        'position',
        'points',
        'win',
        'draw',
        'loss',
        'created_at',
        'played',
        'form',
        'team_division',
        'unavailable',
        'strength_overall_home',
        'strength_overall_away',
        'strength_attack_home',
        'strength_attack_away',
        'strength_defence_home',
        'strength_defence_away',
        'pulse_id',
        'updated_at',
      ],
      rows.teams,
    ],
    [
      'players_history',
      [
        'season',
        'id',
        'code',
        'type',
        'team_id',
        'price',
        'start_price',
        'first_name',
        'second_name',
        'web_name',
        'created_at',
        'updated_at',
        'total_points',
        'price_source_checked_at',
      ],
      rows.players,
    ],
    [
      'phases_history',
      [
        'season',
        'id',
        'name',
        'start_event',
        'stop_event',
        'highest_score',
        'created_at',
        'updated_at',
      ],
      rows.phases,
    ],
    [
      'event_fixtures_history',
      [
        'season',
        'id',
        'code',
        'event_id',
        'kickoff_time',
        'started',
        'finished',
        'minutes',
        'team_h_id',
        'team_h_difficulty',
        'team_h_score',
        'team_a_id',
        'team_a_difficulty',
        'team_a_score',
        'created_at',
        'finished_provisional',
        'provisional_start_time',
        'stats',
        'pulse_id',
        'updated_at',
      ],
      rows.eventFixtures,
    ],
    [
      'player_stats_history',
      [
        'season',
        'id',
        'event_id',
        'element_id',
        'element_type',
        'total_points',
        'form',
        'influence',
        'creativity',
        'threat',
        'ict_index',
        'expected_goals',
        'expected_assists',
        'expected_goal_involvements',
        'expected_goals_conceded',
        'minutes',
        'goals_scored',
        'assists',
        'clean_sheets',
        'goals_conceded',
        'own_goals',
        'penalties_saved',
        'yellow_cards',
        'red_cards',
        'saves',
        'bonus',
        'bps',
        'starts',
        'influence_rank',
        'influence_rank_type',
        'creativity_rank',
        'creativity_rank_type',
        'threat_rank',
        'threat_rank_type',
        'ict_index_rank',
        'ict_index_rank_type',
        'created_at',
        'updated_at',
        'transfers_in',
        'transfers_in_event',
        'transfers_out',
        'transfers_out_event',
        'selected_by_percent',
      ],
      rows.playerStats,
    ],
    [
      'event_lives_history',
      [
        'season',
        'id',
        'event_id',
        'element_id',
        'minutes',
        'goals_scored',
        'assists',
        'clean_sheets',
        'goals_conceded',
        'own_goals',
        'penalties_saved',
        'penalties_missed',
        'yellow_cards',
        'red_cards',
        'saves',
        'bonus',
        'bps',
        'starts',
        'expected_goals',
        'expected_assists',
        'expected_goal_involvements',
        'expected_goals_conceded',
        'in_dream_team',
        'total_points',
        'created_at',
        'updated_at',
        'defensive_contribution',
      ],
      rows.eventLives,
    ],
    [
      'event_live_explains_history',
      [
        'season',
        'id',
        'event_id',
        'element_id',
        'bonus',
        'minutes',
        'minutes_points',
        'goals_scored',
        'goals_scored_points',
        'assists',
        'assists_points',
        'clean_sheets',
        'clean_sheets_points',
        'goals_conceded',
        'goals_conceded_points',
        'own_goals',
        'own_goals_points',
        'penalties_saved',
        'penalties_saved_points',
        'penalties_missed',
        'penalties_missed_points',
        'yellow_cards',
        'yellow_cards_points',
        'red_cards',
        'red_cards_points',
        'saves',
        'saves_points',
        'created_at',
        'updated_at',
        'defensive_contribution',
        'defensive_contribution_points',
      ],
      rows.eventLiveExplains,
    ],
    [
      'event_live_summaries_history',
      [
        'season',
        'id',
        'element_id',
        'element_type',
        'minutes',
        'goals_scored',
        'assists',
        'clean_sheets',
        'goals_conceded',
        'own_goals',
        'penalties_saved',
        'penalties_missed',
        'yellow_cards',
        'red_cards',
        'saves',
        'bonus',
        'bps',
        'total_points',
        'created_at',
        'updated_at',
      ],
      rows.eventLiveSummaries,
    ],
    [
      'player_values_history',
      [
        'season',
        'id',
        'element_id',
        'element_type',
        'event_id',
        'value',
        'change_date',
        'last_value',
        'created_at',
        'change_type',
      ],
      rows.playerValues,
    ],
    [
      'player_market_snapshots_history',
      [
        'season',
        'id',
        'snapshot_date',
        'captured_at',
        'element_id',
        'player_code',
        'web_name',
        'first_name',
        'second_name',
        'team_id',
        'team_name',
        'team_short_name',
        'element_type',
        'position',
        'price',
        'selected_by_percent',
        'transfers_in',
        'transfers_out',
        'transfers_in_event',
        'transfers_out_event',
        'status',
        'news',
        'news_added',
        'chance_of_playing_this_round',
        'chance_of_playing_next_round',
      ],
      rows.playerMarketSnapshots,
    ],
    [
      'fpl_player_fixture_stats_history',
      [
        'season',
        'id',
        'event_id',
        'fixture_id',
        'fixture_code',
        'element_id',
        'player_code',
        'team_id',
        'team_code',
        'element_type',
        'minutes',
        'starts',
        'goals',
        'assists',
        'own_goals',
        'yellow_cards',
        'red_cards',
        'source_hash',
        'created_at',
        'updated_at',
      ],
      rows.playerFixtureStats,
    ],
  ];
}

async function countAndChecksum(
  tx: SqlExecutor,
  table: string,
): Promise<{ count: number; checksum: string }> {
  const result = (await tx.unsafe(
    `SELECT count(*)::int AS row_count, md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY t.id), '')) AS checksum FROM public.${table} t WHERE t.season = $1`,
    [season],
  )) as Array<{ row_count: number; checksum: string }>;
  if (!result[0]) throw new Error(`No checksum result for ${table}`);
  return { count: Number(result[0].row_count), checksum: result[0].checksum };
}

async function deleteSeason(tx: SqlExecutor): Promise<void> {
  await tx.unsafe('DELETE FROM public.fpl_season_archive_items WHERE season = $1', [season]);
  for (const table of HISTORY_TABLES.slice().reverse())
    await tx.unsafe(`DELETE FROM public.${table} WHERE season = $1`, [season]);
}

async function verifyAndSeal(tx: SqlExecutor, rows: ArchiveRows): Promise<void> {
  const expected: Record<string, number> = {
    events_history: rows.events.length,
    teams_history: rows.teams.length,
    players_history: rows.players.length,
    phases_history: rows.phases.length,
    event_fixtures_history: rows.eventFixtures.length,
    player_stats_history: rows.playerStats.length,
    event_lives_history: rows.eventLives.length,
    event_live_explains_history: rows.eventLiveExplains.length,
    event_live_summaries_history: rows.eventLiveSummaries.length,
    player_values_history: rows.playerValues.length,
    player_market_snapshots_history: rows.playerMarketSnapshots.length,
    fpl_player_fixture_stats_history: rows.playerFixtureStats.length,
  };
  const verifiedAt = new Date().toISOString();
  for (const [sourceTable, archiveTable] of ARCHIVE_ITEMS) {
    const actual = await countAndChecksum(tx, archiveTable);
    if (actual.count !== expected[archiveTable]) throw new Error(`${archiveTable} count mismatch`);
    await tx.unsafe(
      'INSERT INTO public.fpl_season_archive_items (season,source_table,archive_table,row_count,canonical_checksum,verified_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$6)',
      [season, sourceTable, archiveTable, actual.count, actual.checksum, verifiedAt],
    );
  }
  await tx.unsafe(
    'UPDATE public.fpl_season_archives SET status=$2,reason=$3,source_core_revision=$4,completed_at=$5,error_summary=NULL,updated_at=$5 WHERE season=$1',
    [
      season,
      'sealed',
      'Backfilled from Vaastav Fantasy Premier League per-gameweek CSV and fixtures.csv. Fixture/player performance and value/selected counts are preserved; historical element-summary status/news/chance and per-GW ownership denominator were not available. One final-player snapshot correction was reconciled into the final event aggregate.',
      `https://github.com/vaastav/Fantasy-Premier-League/tree/${seasonDirectory(season)}; source=${sourceDir}; imported_at=${importedAt}`,
      verifiedAt,
    ],
  );
}

async function applyRows(rows: ArchiveRows): Promise<void> {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for --apply');
  const db = postgres(databaseUrl, {
    max: 1,
    prepare: !isTransactionPoolerConnection(databaseUrl),
  });
  try {
    await db.begin(async (transaction) => {
      const tx = transaction as unknown as SqlExecutor;
      await tx.unsafe(
        'INSERT INTO public.fpl_season_archives (season,status,reason) VALUES ($1,$2,$3) ON CONFLICT (season) DO NOTHING',
        [season, 'unavailable', 'Historical FPL source is being prepared for table-only backfill'],
      );
      await tx.unsafe(
        'UPDATE public.fpl_season_archives SET status=$2,started_at=$3,completed_at=NULL,error_summary=NULL,updated_at=$3 WHERE season=$1',
        [season, 'building', importedAt],
      );
      await deleteSeason(tx);
      for (const [table, columns, tableRows] of rowsByTable(rows))
        await insertRows(tx, table, columns, tableRows);
      await verifyAndSeal(tx, rows);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error);
    await db.unsafe(
      'UPDATE public.fpl_season_archives SET status=$2,error_summary=$3,updated_at=now() WHERE season=$1',
      [season, 'failed', message],
    );
    throw error;
  } finally {
    await db.end();
  }
}

function report(rows: ArchiveRows): void {
  const caveats = [
    'Vaastav provides per-gameweek transformed CSV, not preserved element-summary JSON for this season.',
    'event_live_summaries_history stores one season aggregate per element_id, summed from event live rows.',
    'Historical status/news/chance fields are unknown/null; per-GW ownership percentages are 0 except the final players_raw snapshot because ranked_count is absent.',
    'FPL event deadline is represented by the earliest fixture kickoff in that GW; blank gameweeks with no fixture retain a NULL deadline because the source has no bootstrap event metadata.',
    'One final-player season aggregate correction is reconciled into GW38; the original fixture evidence remains unchanged.',
  ];
  if (season === '1920') {
    caveats.push(
      'For 2019/20, source fixture events 39-47 are mapped to FPL gameweeks 30-38; stale zero-stat rows duplicated in gw29 are excluded in favor of the resumed-match files.',
    );
  }
  if (season === '1819') {
    caveats.push(
      'For 2018/19, team metadata is read from the preserved raw.json bootstrap snapshot because the source has no teams.csv.',
    );
    caveats.push(
      'For 2018/19, raw team metadata has no pulse_id; the unique team code is used as a deterministic pulse_id proxy.',
    );
    caveats.push(
      'For 2018/19, fixture metadata has no pulse_id; the unique fixture code is used as a deterministic pulse_id proxy.',
    );
  }
  if (season === '1718' || season === '1617') {
    caveats.push(
      'For this older season, teams are derived from players_raw.csv because the source has no teams.csv or raw.json team snapshot; official FPL team-code mappings restore the historical names.',
    );
    caveats.push(
      'For this older season, fixtures are reconstructed from per-gameweek opponent/home-score rows because the source has no fixtures.csv; fixture stats JSON and difficulty fields remain unknown.',
    );
  }
  console.log(
    JSON.stringify(
      {
        season,
        mode: shouldApply ? 'apply' : 'dry-run',
        importedAt,
        source: sourceDir,
        rows: {
          events: rows.events.length,
          teams: rows.teams.length,
          players: rows.players.length,
          phases: rows.phases.length,
          eventFixtures: rows.eventFixtures.length,
          playerStats: rows.playerStats.length,
          eventLives: rows.eventLives.length,
          eventLiveExplains: rows.eventLiveExplains.length,
          eventLiveSummaries: rows.eventLiveSummaries.length,
          playerValues: rows.playerValues.length,
          playerMarketSnapshots: rows.playerMarketSnapshots.length,
          playerFixtureStats: rows.playerFixtureStats.length,
        },
        caveats,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const source = await loadSource();
  const rows = buildRows(source.players, source.teams, source.fixtures, source.gameweeks);
  report(rows);
  if (shouldApply) {
    await applyRows(rows);
    console.log(`sealed season ${season}`);
  } else {
    console.log(`dry-run only; pass --apply to write history tables for ${season}`);
  }
}

main().catch((error) => {
  console.error('Vaastav FPL history backfill failed', error);
  process.exitCode = 1;
});
