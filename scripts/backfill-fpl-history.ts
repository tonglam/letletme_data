/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import postgres from 'postgres';

import { isTransactionPoolerConnection } from '../src/db/postgres-connection';

const season = getOption('season') ?? '2526';
const shouldApply = process.argv.includes('--apply');
const importedAt = new Date().toISOString();

const RAW_SOURCE_URL =
  process.env.FPL_RAW_SOURCE_URL ??
  'https://raw.githubusercontent.com/npomfret/raw-fpl-data/main/data/2025-2026';
const ELEMENT_SUMMARY_SOURCE_URL =
  process.env.FPL_ELEMENT_SUMMARY_SOURCE_URL ??
  'https://raw.githubusercontent.com/TopMarxFPL/fpl-mirror/main/data/2025/players';
const RAW_SOURCE_DIR = process.env.FPL_RAW_SOURCE_DIR;
const ELEMENT_SUMMARY_SOURCE_DIR = process.env.FPL_ELEMENT_SUMMARY_SOURCE_DIR;
const databaseUrl = process.env.DATABASE_URL;

const EVENT_COUNT = 38;
const TEAM_COUNT = 20;
const PLAYER_COUNT = 841;
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

type JsonRecord = Record<string, unknown>;
type Row = Record<string, unknown>;
type SqlExecutor = {
  unsafe: (query: string, values?: unknown[]) => Promise<unknown>;
};

interface SourceEvent {
  id: number;
  raw: JsonRecord;
}

interface SourceTeam {
  id: number;
  code: number;
  raw: JsonRecord;
}

interface SourcePlayer {
  id: number;
  code: number;
  type: number;
  teamId: number;
  startPrice: number;
  raw: JsonRecord;
}

interface SourcePhase {
  id: number;
  raw: JsonRecord;
}

interface SourceFixture {
  id: number;
  code: number;
  eventId: number;
  teamAId: number;
  teamHId: number;
  raw: JsonRecord;
}

interface LiveElement {
  id: number;
  stats: JsonRecord;
  explain: JsonRecord[];
}

interface FixtureStatRow {
  side: 'a' | 'h';
  raw: JsonRecord;
}

interface SummaryHistoryRow {
  eventId: number;
  fixtureId: number;
  kickoffTime: string | null;
  value: number;
  selected: number;
  transfersIn: number;
  transfersOut: number;
  wasHome: boolean;
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

interface PlayerMarketIndex {
  observedByEvent: Map<number, SummaryHistoryRow>;
  stateByEvent: Map<number, MarketState>;
}

interface SourceData {
  events: SourceEvent[];
  teams: SourceTeam[];
  players: SourcePlayer[];
  phases: SourcePhase[];
  fixtures: SourceFixture[];
  liveByEvent: Map<number, LiveElement[]>;
  fixtureStatsByFixture: Map<number, FixtureStatRow[]>;
  marketByPlayer: Map<number, PlayerMarketIndex>;
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
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function objectValue(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as JsonRecord;
}

function objectArray(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}`);
  }
  return value.map((entry, index) => objectValue(entry, `${label}[${index}]`));
}

function numberValue(value: unknown, label: string, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Expected number for ${label}`);
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = numberValue(value, label, Number.NaN);
  if (!Number.isFinite(parsed)) throw new Error(`Expected finite number for ${label}`);
  return parsed;
}

function integerValue(value: unknown, label: string, fallback = 0): number {
  const parsed = numberValue(value, label, fallback);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer for ${label}: ${parsed}`);
  return parsed;
}

function buildSeasonEventLiveSummaries(
  season: string,
  eventLivesRows: readonly Row[],
  playersById: Map<number, SourcePlayer>,
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

function nonNegativeInteger(value: unknown, label: string, fallback = 0): number {
  const parsed = integerValue(value, label, fallback);
  if (parsed < 0) throw new Error(`Expected non-negative integer for ${label}: ${parsed}`);
  return parsed;
}

function booleanValue(value: unknown, label: string, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  throw new Error(`Expected boolean for ${label}`);
}

function stringValue(value: unknown, label: string, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  throw new Error(`Expected string for ${label}`);
}

function jsonText(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function sourcePath(relativePath: string): string {
  if (!RAW_SOURCE_DIR) throw new Error('RAW_SOURCE_DIR is not configured');
  return join(RAW_SOURCE_DIR, ...relativePath.split('/'));
}

async function fetchJson(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'letletme-data-fpl-history-backfill/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status} for ${url}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * attempt, 4_000)));
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
}

async function loadRawJson(relativePath: string): Promise<unknown> {
  if (RAW_SOURCE_DIR) return Bun.file(sourcePath(relativePath)).json();
  return fetchJson(`${RAW_SOURCE_URL}/${relativePath}`);
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as JsonRecord;
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

function dateOnly(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error(`Expected ISO date, received ${value ?? 'null'}`);
  }
  return value.slice(0, 10);
}

function dateKey(value: string): string {
  return value.replaceAll('-', '');
}

function positionForType(type: number): string {
  return ({ 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' } as Record<number, string>)[type] ?? 'UNK';
}

function slugName(value: string): string {
  const special = value
    .replaceAll('Ø', 'O')
    .replaceAll('ø', 'o')
    .replaceAll('Đ', 'D')
    .replaceAll('đ', 'd')
    .replaceAll('Ł', 'L')
    .replaceAll('ł', 'l')
    .replaceAll('ß', 'ss');
  return special
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replaceAll(' ', '_')
    .replaceAll('/', '_')
    .replaceAll(/'/g, '')
    .replaceAll('(', '')
    .replaceAll(')', '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_');
}

function getLocalSummaryFiles(): Map<string, string> {
  if (!ELEMENT_SUMMARY_SOURCE_DIR) return new Map();
  const files = readdirSync(ELEMENT_SUMMARY_SOURCE_DIR).filter((file) => file.endsWith('.json'));
  const result = new Map<string, string>();
  for (const file of files) {
    const match = /^(\d+).*_(\d+)\.json$/.exec(file);
    if (match) result.set(`${match[1]}:${match[2]}`, join(ELEMENT_SUMMARY_SOURCE_DIR, file));
  }
  return result;
}

async function loadElementSummary(
  player: SourcePlayer,
  localFiles: Map<string, string>,
): Promise<JsonRecord> {
  const localFile = localFiles.get(`${player.id}:${player.code}`);
  const raw = localFile
    ? await Bun.file(localFile).json()
    : await fetchJson(
        `${ELEMENT_SUMMARY_SOURCE_URL}/${player.id}_${slugName(
          stringValue(player.raw.first_name, `player ${player.id} first_name`),
        )}_${slugName(stringValue(player.raw.second_name, `player ${player.id} second_name`))}_${player.code}.json`,
      );
  const summary = objectValue(raw, `element-summary/${player.id}`);
  if (!Array.isArray(summary.history)) {
    throw new Error(`element-summary/${player.id} has no history array`);
  }
  return summary;
}

function parseSummaryHistory(
  player: SourcePlayer,
  summary: JsonRecord,
  fixturesById: Map<number, SourceFixture>,
): SummaryHistoryRow[] {
  return objectArray(summary.history, `element-summary/${player.id}.history`).map((raw, index) => {
    const fixtureId = integerValue(raw.fixture, `player ${player.id} history[${index}].fixture`);
    const fixture = fixturesById.get(fixtureId);
    if (!fixture)
      throw new Error(`Player ${player.id} history references unknown fixture ${fixtureId}`);
    const eventId = fixture.eventId;
    return {
      eventId,
      fixtureId,
      kickoffTime: raw.kickoff_time === null ? null : stringValue(raw.kickoff_time, 'kickoff_time'),
      value: nonNegativeInteger(raw.value, `player ${player.id} value`),
      selected: nonNegativeInteger(raw.selected, `player ${player.id} selected`),
      transfersIn: nonNegativeInteger(raw.transfers_in, `player ${player.id} transfers_in`),
      transfersOut: nonNegativeInteger(raw.transfers_out, `player ${player.id} transfers_out`),
      wasHome: booleanValue(raw.was_home, `player ${player.id} was_home`),
    };
  });
}

function buildMarketIndex(
  player: SourcePlayer,
  history: SummaryHistoryRow[],
  fixturesById: Map<number, SourceFixture>,
): PlayerMarketIndex {
  const byEvent = new Map<number, SummaryHistoryRow[]>();
  for (const row of history) {
    const rows = byEvent.get(row.eventId) ?? [];
    rows.push(row);
    byEvent.set(row.eventId, rows);
  }

  const observedByEvent = new Map<number, SummaryHistoryRow>();
  for (const [eventId, rows] of byEvent) {
    rows.sort((left, right) => {
      const leftTime = left.kickoffTime ? Date.parse(left.kickoffTime) : 0;
      const rightTime = right.kickoffTime ? Date.parse(right.kickoffTime) : 0;
      return leftTime - rightTime || left.fixtureId - right.fixtureId;
    });
    observedByEvent.set(eventId, rows[rows.length - 1]);
  }

  let lastValue = player.startPrice;
  let selected = 0;
  let transfersIn = 0;
  let transfersOut = 0;
  let teamId = player.teamId;
  const stateByEvent = new Map<number, MarketState>();
  for (let eventId = 1; eventId <= EVENT_COUNT; eventId += 1) {
    const observed = observedByEvent.get(eventId);
    let transfersInEvent = 0;
    let transfersOutEvent = 0;
    if (observed) {
      lastValue = observed.value;
      selected = observed.selected;
      transfersInEvent = observed.transfersIn;
      transfersOutEvent = observed.transfersOut;
      transfersIn += transfersInEvent;
      transfersOut += transfersOutEvent;
      const fixture = fixturesById.get(observed.fixtureId);
      if (!fixture) {
        throw new Error(`Missing fixture ${observed.fixtureId} while building market index`);
      }
      teamId = observed.wasHome ? fixture.teamHId : fixture.teamAId;
    }
    stateByEvent.set(eventId, {
      value: lastValue,
      selected,
      transfersIn,
      transfersOut,
      transfersInEvent,
      transfersOutEvent,
      teamId,
      observed: observed !== undefined,
    });
  }
  return { observedByEvent, stateByEvent };
}

async function loadSourceData(): Promise<SourceData> {
  if (season !== '2526') {
    throw new Error(`Only season 2526 is wired in this importer; received ${season}`);
  }

  const bootstrap = objectValue(await loadRawJson('bootstrap-static.json'), 'bootstrap-static');
  const rawEvents = objectArray(bootstrap.events, 'bootstrap.events');
  const rawTeams = objectArray(bootstrap.teams, 'bootstrap.teams');
  const rawPlayers = objectArray(bootstrap.elements, 'bootstrap.elements');
  const rawPhases = objectArray(bootstrap.phases, 'bootstrap.phases');
  const rawFixtures = objectArray(await loadRawJson('fixtures.json'), 'fixtures');

  const events = rawEvents.map((raw) => ({
    id: integerValue(raw.id, 'event.id'),
    raw,
  }));
  const teams = rawTeams.map((raw) => ({
    id: integerValue(raw.id, 'team.id'),
    code: integerValue(raw.code, 'team.code'),
    raw,
  }));
  const players = rawPlayers.map((raw) => {
    const id = integerValue(raw.id, 'player.id');
    const price = nonNegativeInteger(raw.now_cost, `player ${id} now_cost`);
    return {
      id,
      code: integerValue(raw.code, `player ${id} code`),
      type: integerValue(raw.element_type, `player ${id} element_type`),
      teamId: integerValue(raw.team, `player ${id} team`),
      startPrice: price - integerValue(raw.cost_change_start, `player ${id} cost_change_start`),
      raw,
    };
  });
  const phases = rawPhases.map((raw) => ({ id: integerValue(raw.id, 'phase.id'), raw }));
  const fixtures = rawFixtures.map((raw) => ({
    id: integerValue(raw.id, 'fixture.id'),
    code: integerValue(raw.code, 'fixture.code'),
    eventId: integerValue(raw.event, 'fixture.event'),
    teamAId: integerValue(raw.team_a, 'fixture.team_a'),
    teamHId: integerValue(raw.team_h, 'fixture.team_h'),
    raw,
  }));

  if (events.length !== EVENT_COUNT)
    throw new Error(`Expected ${EVENT_COUNT} events, got ${events.length}`);
  if (teams.length !== TEAM_COUNT)
    throw new Error(`Expected ${TEAM_COUNT} teams, got ${teams.length}`);
  if (players.length !== PLAYER_COUNT)
    throw new Error(`Expected ${PLAYER_COUNT} players, got ${players.length}`);
  if (fixtures.length !== FIXTURE_COUNT) {
    throw new Error(`Expected ${FIXTURE_COUNT} fixtures, got ${fixtures.length}`);
  }

  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const liveEntries = await mapConcurrent(events, 8, async (event) => {
    const raw = objectValue(
      await loadRawJson(`events/${event.id}/live.json`),
      `event ${event.id} live`,
    );
    const elements = objectArray(raw.elements, `event ${event.id} live.elements`).map(
      (element) => ({
        id: integerValue(element.id, `event ${event.id} live element.id`),
        stats: objectValue(element.stats, `event ${event.id} live element.stats`),
        explain: Array.isArray(element.explain)
          ? objectArray(element.explain, `event ${event.id} live element.explain`)
          : [],
      }),
    );
    return [event.id, elements] as const;
  });
  const liveByEvent = new Map(liveEntries);

  const fixtureStatEntries = await mapConcurrent(fixtures, 12, async (fixture) => {
    const raw = objectValue(
      await loadRawJson(`fixtures/${fixture.id}/stats.json`),
      `fixture ${fixture.id} stats`,
    );
    const rows: FixtureStatRow[] = [];
    for (const side of ['a', 'h'] as const) {
      for (const entry of objectArray(raw[side], `fixture ${fixture.id} stats.${side}`)) {
        const entryFixtureId = integerValue(entry.fixture, `fixture ${fixture.id} stats fixture`);
        if (entryFixtureId !== fixture.id) {
          throw new Error(`Fixture stats row ${entryFixtureId} is in fixture ${fixture.id}`);
        }
        rows.push({ side, raw: entry });
      }
    }
    return [fixture.id, rows] as const;
  });
  const fixtureStatsByFixture = new Map(fixtureStatEntries);

  const localSummaryFileMap = getLocalSummaryFiles();
  const summaries = await mapConcurrent(players, 12, async (player) => {
    const summary = await loadElementSummary(player, localSummaryFileMap);
    return [player.id, parseSummaryHistory(player, summary, fixturesById)] as const;
  });
  const historyByPlayer = new Map(summaries);
  const marketByPlayer = new Map(
    players.map((player) => [
      player.id,
      buildMarketIndex(player, historyByPlayer.get(player.id) ?? [], fixturesById),
    ]),
  );

  return {
    events,
    teams,
    players,
    phases,
    fixtures,
    liveByEvent,
    fixtureStatsByFixture,
    marketByPlayer,
  };
}

function buildRows(source: SourceData): ArchiveRows {
  const eventsById = new Map(source.events.map((event) => [event.id, event]));
  const teamsById = new Map(source.teams.map((team) => [team.id, team]));
  const playersById = new Map(source.players.map((player) => [player.id, player]));
  const eventsRows: Row[] = source.events.map(({ id, raw }) => ({
    season,
    id,
    name: stringValue(raw.name, `event ${id} name`),
    deadline_time:
      raw.deadline_time === null ? null : stringValue(raw.deadline_time, 'deadline_time'),
    average_entry_score: optionalNumber(raw.average_entry_score, 'average_entry_score'),
    finished: booleanValue(raw.finished, `event ${id} finished`),
    data_checked: booleanValue(raw.data_checked, `event ${id} data_checked`),
    highest_scoring_entry: optionalNumber(raw.highest_scoring_entry, 'highest_scoring_entry'),
    deadline_time_epoch: optionalNumber(raw.deadline_time_epoch, 'deadline_time_epoch'),
    deadline_time_game_offset: optionalNumber(
      raw.deadline_time_game_offset,
      'deadline_time_game_offset',
    ),
    highest_score: optionalNumber(raw.highest_score, 'highest_score'),
    is_previous: booleanValue(raw.is_previous, 'is_previous'),
    is_current: booleanValue(raw.is_current, 'is_current'),
    is_next: booleanValue(raw.is_next, 'is_next'),
    cup_league_create: booleanValue(raw.cup_leagues_created, 'cup_leagues_created'),
    h2h_ko_matches_created: booleanValue(raw.h2h_ko_matches_created, 'h2h_ko_matches_created'),
    chip_plays: jsonText(raw.chip_plays),
    most_selected: optionalNumber(raw.most_selected, 'most_selected'),
    most_transferred_in: optionalNumber(raw.most_transferred_in, 'most_transferred_in'),
    top_element: optionalNumber(raw.top_element, 'top_element'),
    top_element_info: jsonText(raw.top_element_info),
    transfers_made: optionalNumber(raw.transfers_made, 'transfers_made'),
    most_captained: optionalNumber(raw.most_captained, 'most_captained'),
    most_vice_captained: optionalNumber(raw.most_vice_captained, 'most_vice_captained'),
    created_at: importedAt,
    updated_at: importedAt,
    live_snapshot_checked_at: importedAt,
    live_snapshot_finalized_at: importedAt,
  }));

  const teamsRows: Row[] = source.teams.map(({ id, code, raw }) => ({
    season,
    id,
    code,
    name: stringValue(raw.name, `team ${id} name`),
    short_name: stringValue(raw.short_name, `team ${id} short_name`),
    strength: optionalNumber(raw.strength, 'team strength'),
    position: integerValue(raw.position, `team ${id} position`),
    points: integerValue(raw.points, `team ${id} points`),
    win: integerValue(raw.win, `team ${id} win`),
    draw: integerValue(raw.draw, `team ${id} draw`),
    loss: integerValue(raw.loss, `team ${id} loss`),
    created_at: importedAt,
    played: integerValue(raw.played, `team ${id} played`),
    form: raw.form === null ? null : stringValue(raw.form, `team ${id} form`),
    team_division: optionalNumber(raw.team_division, 'team_division'),
    unavailable: booleanValue(raw.unavailable, `team ${id} unavailable`),
    strength_overall_home: integerValue(raw.strength_overall_home, 'strength_overall_home'),
    strength_overall_away: integerValue(raw.strength_overall_away, 'strength_overall_away'),
    strength_attack_home: integerValue(raw.strength_attack_home, 'strength_attack_home'),
    strength_attack_away: integerValue(raw.strength_attack_away, 'strength_attack_away'),
    strength_defence_home: integerValue(raw.strength_defence_home, 'strength_defence_home'),
    strength_defence_away: integerValue(raw.strength_defence_away, 'strength_defence_away'),
    pulse_id: integerValue(raw.pulse_id, `team ${id} pulse_id`),
    updated_at: importedAt,
  }));

  const playersRows: Row[] = source.players.map(({ id, code, type, teamId, startPrice, raw }) => ({
    season,
    id,
    code,
    type,
    team_id: teamId,
    price: nonNegativeInteger(raw.now_cost, `player ${id} now_cost`),
    start_price: startPrice,
    first_name:
      raw.first_name === null ? null : stringValue(raw.first_name, `player ${id} first_name`),
    second_name:
      raw.second_name === null ? null : stringValue(raw.second_name, `player ${id} second_name`),
    web_name: stringValue(raw.web_name, `player ${id} web_name`),
    created_at: importedAt,
    updated_at: importedAt,
    total_points: optionalNumber(raw.total_points, `player ${id} total_points`),
    price_source_checked_at: importedAt,
  }));

  const phasesRows: Row[] = source.phases.map(({ id, raw }) => ({
    season,
    id,
    name: stringValue(raw.name, `phase ${id} name`),
    start_event: integerValue(raw.start_event, `phase ${id} start_event`),
    stop_event: integerValue(raw.stop_event, `phase ${id} stop_event`),
    highest_score: optionalNumber(raw.highest_score, `phase ${id} highest_score`),
    created_at: importedAt,
    updated_at: importedAt,
  }));

  const eventFixturesRows: Row[] = source.fixtures.map(
    ({ id, code, eventId, teamAId, teamHId, raw }) => ({
      season,
      id,
      code,
      event_id: eventId,
      kickoff_time:
        raw.kickoff_time === null
          ? null
          : stringValue(raw.kickoff_time, `fixture ${id} kickoff_time`),
      started: booleanValue(raw.started, `fixture ${id} started`),
      finished: booleanValue(raw.finished, `fixture ${id} finished`),
      minutes: integerValue(raw.minutes, `fixture ${id} minutes`),
      team_h_id: teamHId,
      team_h_difficulty: optionalNumber(raw.team_h_difficulty, 'team_h_difficulty'),
      team_h_score: optionalNumber(raw.team_h_score, 'team_h_score'),
      team_a_id: teamAId,
      team_a_difficulty: optionalNumber(raw.team_a_difficulty, 'team_a_difficulty'),
      team_a_score: optionalNumber(raw.team_a_score, 'team_a_score'),
      created_at: importedAt,
      finished_provisional: booleanValue(
        raw.finished_provisional,
        `fixture ${id} finished_provisional`,
      ),
      provisional_start_time: booleanValue(
        raw.provisional_start_time,
        `fixture ${id} provisional_start_time`,
      ),
      stats: jsonText(raw.stats) ?? '[]',
      pulse_id: integerValue(raw.pulse_id, `fixture ${id} pulse_id`),
      updated_at: importedAt,
    }),
  );

  const eventLivesRows: Row[] = [];
  const eventLiveExplainsRows: Row[] = [];
  const playerStatsRows: Row[] = [];
  const playerMarketSnapshotsRows: Row[] = [];
  const eventLiveSummariesRows: Row[] = [];
  const playerValuesRows: Row[] = [];
  const cumulativeByPlayer = new Map<number, JsonRecord>();

  for (let eventId = 1; eventId <= EVENT_COUNT; eventId += 1) {
    const event = eventsById.get(eventId);
    if (!event) throw new Error(`Missing source event ${eventId}`);
    const liveElements = source.liveByEvent.get(eventId) ?? [];
    const rankedCount = Math.max(
      1,
      integerValue(event.raw.ranked_count, `event ${eventId} ranked_count`),
    );
    const deadlineTime = stringValue(event.raw.deadline_time, `event ${eventId} deadline_time`);
    for (const element of liveElements) {
      const player = playersById.get(element.id);
      if (!player) throw new Error(`Event ${eventId} live references unknown player ${element.id}`);
      const stats = element.stats;
      const market = source.marketByPlayer.get(element.id)?.stateByEvent.get(eventId);
      if (!market)
        throw new Error(`Missing market state for player ${element.id}, event ${eventId}`);

      eventLivesRows.push({
        season,
        id: eventId * PLAYER_ID_MULTIPLIER + element.id,
        event_id: eventId,
        element_id: element.id,
        minutes: optionalNumber(stats.minutes, 'event live minutes'),
        goals_scored: optionalNumber(stats.goals_scored, 'event live goals_scored'),
        assists: optionalNumber(stats.assists, 'event live assists'),
        clean_sheets: optionalNumber(stats.clean_sheets, 'event live clean_sheets'),
        goals_conceded: optionalNumber(stats.goals_conceded, 'event live goals_conceded'),
        own_goals: optionalNumber(stats.own_goals, 'event live own_goals'),
        penalties_saved: optionalNumber(stats.penalties_saved, 'event live penalties_saved'),
        penalties_missed: optionalNumber(stats.penalties_missed, 'event live penalties_missed'),
        yellow_cards: optionalNumber(stats.yellow_cards, 'event live yellow_cards'),
        red_cards: optionalNumber(stats.red_cards, 'event live red_cards'),
        saves: optionalNumber(stats.saves, 'event live saves'),
        bonus: optionalNumber(stats.bonus, 'event live bonus'),
        bps: optionalNumber(stats.bps, 'event live bps'),
        // The upstream field was introduced during the season. Missing
        // early-season values have the same meaning as zero.
        defensive_contribution: integerValue(
          stats.defensive_contribution,
          'event live defensive_contribution',
          0,
        ),
        starts:
          optionalNumber(stats.starts, 'event live starts') !== null &&
          numberValue(stats.starts, 'starts') > 0,
        expected_goals: optionalNumber(stats.expected_goals, 'event live expected_goals'),
        expected_assists: optionalNumber(stats.expected_assists, 'event live expected_assists'),
        expected_goal_involvements: optionalNumber(
          stats.expected_goal_involvements,
          'event live expected_goal_involvements',
        ),
        expected_goals_conceded: optionalNumber(
          stats.expected_goals_conceded,
          'event live expected_goals_conceded',
        ),
        in_dream_team: booleanValue(stats.in_dreamteam, 'event live in_dreamteam'),
        total_points: integerValue(stats.total_points, 'event live total_points'),
        created_at: importedAt,
        updated_at: importedAt,
      });

      const explain = buildExplainRow(eventId, element, importedAt);
      eventLiveExplainsRows.push(explain);

      const cumulative = cumulativeByPlayer.get(element.id) ?? createCumulativeStats();
      addCumulativeStats(cumulative, stats);
      cumulativeByPlayer.set(element.id, cumulative);
      const selectedByPercent = ((market.selected / rankedCount) * 100).toFixed(1);
      playerStatsRows.push({
        season,
        id: eventId * PLAYER_ID_MULTIPLIER + element.id,
        event_id: eventId,
        element_id: element.id,
        element_type: player.type,
        total_points: integerValue(cumulative.total_points, 'cumulative total_points'),
        form: null,
        influence: cumulative.influence,
        creativity: cumulative.creativity,
        threat: cumulative.threat,
        ict_index: cumulative.ictIndex,
        expected_goals: cumulative.expectedGoals,
        expected_assists: cumulative.expectedAssists,
        expected_goal_involvements: cumulative.expectedGoalInvolvements,
        expected_goals_conceded: cumulative.expectedGoalsConceded,
        minutes: cumulative.minutes,
        goals_scored: cumulative.goalsScored,
        assists: cumulative.assists,
        clean_sheets: cumulative.cleanSheets,
        goals_conceded: cumulative.goalsConceded,
        own_goals: cumulative.ownGoals,
        penalties_saved: cumulative.penaltiesSaved,
        yellow_cards: cumulative.yellowCards,
        red_cards: cumulative.redCards,
        saves: cumulative.saves,
        bonus: cumulative.bonus,
        bps: cumulative.bps,
        starts: cumulative.starts,
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
        selected_by_percent: selectedByPercent,
      });

      const team = teamsById.get(market.teamId) ?? teamsById.get(player.teamId);
      if (!team) throw new Error(`Missing team ${market.teamId} for player ${element.id}`);
      playerMarketSnapshotsRows.push({
        season,
        id: playerMarketSnapshotsRows.length + 1,
        snapshot_date: dateOnly(deadlineTime),
        captured_at: deadlineTime,
        element_id: element.id,
        player_code: player.code,
        web_name: stringValue(player.raw.web_name, `player ${element.id} web_name`),
        first_name: stringValue(player.raw.first_name, `player ${element.id} first_name`),
        second_name: stringValue(player.raw.second_name, `player ${element.id} second_name`),
        team_id: team.id,
        team_name: stringValue(team.raw.name, `team ${team.id} name`),
        team_short_name: stringValue(team.raw.short_name, `team ${team.id} short_name`),
        element_type: player.type,
        position: positionForType(player.type),
        price: market.value,
        selected_by_percent: Number(selectedByPercent),
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
  }

  eventLiveSummariesRows.push(
    ...buildSeasonEventLiveSummaries(season, eventLivesRows, playersById, importedAt),
  );

  for (const player of source.players) {
    const index = source.marketByPlayer.get(player.id);
    if (!index) throw new Error(`Missing market index for player ${player.id}`);
    let priorValue = 0;
    for (const [eventId, observation] of [...index.observedByEvent.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      const event = eventsById.get(eventId);
      if (!event) throw new Error(`Missing event ${eventId} for value history`);
      const deadlineTime = stringValue(event.raw.deadline_time, `event ${eventId} deadline_time`);
      if (priorValue === 0) {
        playerValuesRows.push({
          season,
          id: playerValuesRows.length + 1,
          element_id: player.id,
          element_type: player.type,
          event_id: eventId,
          value: observation.value,
          change_date: dateKey(dateOnly(deadlineTime)),
          last_value: 0,
          created_at: importedAt,
          change_type: 'start',
        });
      } else if (observation.value !== priorValue) {
        playerValuesRows.push({
          season,
          id: playerValuesRows.length + 1,
          element_id: player.id,
          element_type: player.type,
          event_id: eventId,
          value: observation.value,
          change_date: dateKey(dateOnly(deadlineTime)),
          last_value: priorValue,
          created_at: importedAt,
          change_type: observation.value > priorValue ? 'rise' : 'fall',
        });
      }
      priorValue = observation.value;
    }
  }

  const playerFixtureStatsRows: Row[] = [];
  for (const fixture of source.fixtures) {
    const rows = source.fixtureStatsByFixture.get(fixture.id) ?? [];
    for (const { side, raw } of rows) {
      const elementId = integerValue(raw.element, `fixture ${fixture.id} element`);
      const player = playersById.get(elementId);
      const teamId = side === 'h' ? fixture.teamHId : fixture.teamAId;
      const team = teamsById.get(teamId);
      if (!player || !team) {
        throw new Error(`Fixture ${fixture.id} has unresolved player/team ${elementId}/${teamId}`);
      }
      const base = {
        season,
        eventId: fixture.eventId,
        fixtureId: fixture.id,
        fixtureCode: fixture.code,
        elementId,
        playerCode: player.code,
        teamId,
        teamCode: team.code,
        elementType: player.type,
        minutes: nonNegativeInteger(raw.minutes, 'fixture stat minutes'),
        starts:
          raw.starts === null || raw.starts === undefined
            ? null
            : nonNegativeInteger(raw.starts, 'fixture stat starts'),
        goals: nonNegativeInteger(raw.goals_scored, 'fixture stat goals'),
        assists: nonNegativeInteger(raw.assists, 'fixture stat assists'),
        ownGoals: nonNegativeInteger(raw.own_goals, 'fixture stat own_goals'),
        yellowCards: nonNegativeInteger(raw.yellow_cards, 'fixture stat yellow_cards'),
        redCards: nonNegativeInteger(raw.red_cards, 'fixture stat red_cards'),
      };
      if (base.starts !== null && base.starts > 1) {
        throw new Error(`Fixture ${fixture.id} has invalid starts ${base.starts}`);
      }
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
  }

  const expectedLiveCount = [...source.liveByEvent.values()].reduce(
    (total, elements) => total + elements.length,
    0,
  );
  const expectedFixtureStatCount = [...source.fixtureStatsByFixture.values()].reduce(
    (total, rows) => total + rows.length,
    0,
  );
  if (eventLivesRows.length !== expectedLiveCount) {
    throw new Error(`event live row count mismatch: ${eventLivesRows.length}/${expectedLiveCount}`);
  }
  if (eventLiveExplainsRows.length !== expectedLiveCount) {
    throw new Error(
      `event live explain row count mismatch: ${eventLiveExplainsRows.length}/${expectedLiveCount}`,
    );
  }
  if (playerStatsRows.length !== expectedLiveCount) {
    throw new Error(
      `player stats row count mismatch: ${playerStatsRows.length}/${expectedLiveCount}`,
    );
  }
  if (playerFixtureStatsRows.length !== expectedFixtureStatCount) {
    throw new Error(
      `fixture stats row count mismatch: ${playerFixtureStatsRows.length}/${expectedFixtureStatCount}`,
    );
  }
  const summaryElementIds = new Set(eventLivesRows.map((row) => Number(row.element_id)));
  if (eventLiveSummariesRows.length !== summaryElementIds.size) {
    throw new Error('event live summary does not cover season event live elements');
  }
  if (playerValuesRows.length === 0) throw new Error('No player value history was produced');

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

function createCumulativeStats(): JsonRecord {
  return {
    total_points: 0,
    minutes: 0,
    goals_scored: 0,
    assists: 0,
    clean_sheets: 0,
    goals_conceded: 0,
    own_goals: 0,
    penalties_saved: 0,
    yellow_cards: 0,
    red_cards: 0,
    saves: 0,
    bonus: 0,
    bps: 0,
    starts: 0,
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

function addCumulativeStats(cumulative: JsonRecord, stats: JsonRecord): void {
  const integerFields = [
    'total_points',
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
  ] as const;
  for (const field of integerFields) {
    const current = numberValue(cumulative[field], `cumulative ${field}`);
    cumulative[field] = current + numberValue(stats[field], `event live ${field}`);
  }
  const decimalFields: Array<[string, string]> = [
    ['influence', 'influence'],
    ['creativity', 'creativity'],
    ['threat', 'threat'],
    ['ictIndex', 'ict_index'],
    ['expectedGoals', 'expected_goals'],
    ['expectedAssists', 'expected_assists'],
    ['expectedGoalInvolvements', 'expected_goal_involvements'],
    ['expectedGoalsConceded', 'expected_goals_conceded'],
  ];
  for (const [target, source] of decimalFields) {
    cumulative[target] =
      numberValue(cumulative[target], `cumulative ${target}`) +
      numberValue(stats[source], `event live ${source}`);
  }
}

function buildExplainRow(eventId: number, element: LiveElement, timestamp: string): Row {
  const accumulator = new Map<string, { value: number; points: number }>();
  for (const fixture of element.explain) {
    const stats = objectArray(fixture.stats, `event ${eventId} explain stats`);
    for (const stat of stats) {
      const identifier = stringValue(stat.identifier, 'explain identifier').trim();
      if (!identifier) continue;
      const current = accumulator.get(identifier) ?? { value: 0, points: 0 };
      accumulator.set(identifier, {
        value: current.value + numberValue(stat.value, `explain ${identifier} value`),
        points:
          current.points +
          numberValue(stat.points, `explain ${identifier} points`) +
          numberValue(stat.points_modification, `explain ${identifier} points_modification`),
      });
    }
  }
  const value = (identifier: string): number => accumulator.get(identifier)?.value ?? 0;
  const points = (identifier: string): number => accumulator.get(identifier)?.points ?? 0;
  const has = (identifier: string): boolean => accumulator.has(identifier);
  const stats = element.stats;
  return {
    season,
    id: eventId * PLAYER_ID_MULTIPLIER + element.id,
    event_id: eventId,
    element_id: element.id,
    bonus: numberValue(stats.bonus, 'explain fallback bonus', points('bonus')),
    minutes: optionalNumber(stats.minutes, 'explain minutes'),
    minutes_points: has('minutes') ? points('minutes') : null,
    goals_scored: value('goals_scored'),
    goals_scored_points: points('goals_scored'),
    assists: value('assists'),
    assists_points: points('assists'),
    clean_sheets: value('clean_sheets'),
    clean_sheets_points: points('clean_sheets'),
    goals_conceded: value('goals_conceded'),
    goals_conceded_points: points('goals_conceded'),
    own_goals: value('own_goals'),
    own_goals_points: points('own_goals'),
    penalties_saved: value('penalties_saved'),
    penalties_saved_points: points('penalties_saved'),
    penalties_missed: value('penalties_missed'),
    penalties_missed_points: points('penalties_missed'),
    yellow_cards: value('yellow_cards'),
    yellow_cards_points: points('yellow_cards'),
    red_cards: value('red_cards'),
    red_cards_points: points('red_cards'),
    saves: value('saves'),
    saves_points: points('saves'),
    defensive_contribution: value('defensive_contribution'),
    defensive_contribution_points: points('defensive_contribution'),
    created_at: timestamp,
    updated_at: timestamp,
  };
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
  if (!/^\w+$/.test(table)) throw new Error(`Unsafe table identifier ${table}`);
  const columnSql = columns.map((column) => `"${column}"`).join(', ');
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    let placeholderIndex = 1;
    const placeholders = chunk.map(
      () => `(${columns.map(() => `$${placeholderIndex++}`).join(', ')})`,
    );
    await tx.unsafe(
      `INSERT INTO public."${table}" (${columnSql}) VALUES ${placeholders.join(', ')}`,
      valuesForRows(chunk, columns),
    );
  }
}

async function deleteSeasonRows(tx: SqlExecutor): Promise<void> {
  await tx.unsafe('DELETE FROM public.fpl_season_archive_items WHERE season = $1', [season]);
  for (const table of HISTORY_TABLES.slice().reverse()) {
    await tx.unsafe(`DELETE FROM public.${table} WHERE season = $1`, [season]);
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
    `SELECT count(*)::int AS row_count,
            md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY t.id), '')) AS checksum
     FROM public.${table} t WHERE t.season = $1`,
    [season],
  )) as Array<{ row_count: number; checksum: string }>;
  const row = result[0];
  if (!row) throw new Error(`No checksum result for ${table}`);
  return { count: Number(row.row_count), checksum: row.checksum };
}

async function verifyAndSeal(tx: SqlExecutor, rows: ArchiveRows): Promise<void> {
  const expectedByTable: Record<string, number> = {
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
    const expected = expectedByTable[archiveTable];
    if (actual.count !== expected) {
      throw new Error(`${archiveTable} count mismatch: expected ${expected}, got ${actual.count}`);
    }
    await tx.unsafe(
      `INSERT INTO public.fpl_season_archive_items
        (season, source_table, archive_table, row_count, canonical_checksum, verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
      [season, sourceTable, archiveTable, actual.count, actual.checksum, verifiedAt],
    );
  }

  await tx.unsafe(
    `UPDATE public.fpl_season_archives
     SET status = 'sealed',
         reason = $2,
         source_core_revision = $3,
         completed_at = $4,
         error_summary = NULL,
         updated_at = $4
     WHERE season = $1`,
    [
      season,
      'Backfilled from npomfret raw FPL archive, TopMarxFPL element-summary raw JSON, and raw fixture stats. Historical market status/news/chance fields are unavailable in the preserved element-summary history and are explicitly marked unknown/null; price/value rows are event-granularity observations.',
      `${RAW_SOURCE_URL}; ${ELEMENT_SUMMARY_SOURCE_URL}; imported_at=${importedAt}`,
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
        `UPDATE public.fpl_season_archives
         SET status = 'building', started_at = $2, completed_at = NULL, error_summary = NULL, updated_at = $2
         WHERE season = $1`,
        [season, importedAt],
      );
      await deleteSeasonRows(tx);
      for (const [table, columns, tableRows] of rowsByTable(rows)) {
        await insertRows(tx, table, columns, tableRows);
      }
      await verifyAndSeal(tx, rows);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error);
    await db.unsafe(
      `UPDATE public.fpl_season_archives
       SET status = 'failed', error_summary = $2, updated_at = now()
       WHERE season = $1`,
      [season, message],
    );
    throw error;
  } finally {
    await db.end();
  }
}

function report(rows: ArchiveRows): void {
  console.log(
    JSON.stringify(
      {
        season,
        mode: shouldApply ? 'apply' : 'dry-run',
        importedAt,
        sources: {
          rawArchive: RAW_SOURCE_DIR ?? RAW_SOURCE_URL,
          elementSummary: ELEMENT_SUMMARY_SOURCE_DIR ?? ELEMENT_SUMMARY_SOURCE_URL,
          fixtureStats: RAW_SOURCE_DIR
            ? `${RAW_SOURCE_DIR}/fixtures/{id}/stats.json`
            : `${RAW_SOURCE_URL}/fixtures/{id}/stats.json`,
        },
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
        caveats: [
          'event live and event-live explain are preserved per FPL event/player row.',
          'event_live_summaries_history stores one season aggregate per element_id, summed from event live rows.',
          'element-summary history is used for per-player fixture market observations and event-level value snapshots.',
          'market status/news/chance fields are unavailable historically and are not copied from the final bootstrap snapshot.',
          'player_stats form and historical rank fields are unavailable in the preserved raw sources and remain NULL.',
        ],
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const source = await loadSourceData();
  const rows = buildRows(source);
  report(rows);
  if (shouldApply) {
    await applyRows(rows);
    console.log(`sealed season ${season}`);
  } else {
    console.log(`dry-run only; pass --apply to write history tables for ${season}`);
  }
}

main().catch((error) => {
  console.error('FPL history backfill failed', error);
  process.exitCode = 1;
});
