import {
  BootstrapStaticResponse,
  ElementType,
  Event,
  Fixture,
  LiveEventPlayer,
  Player,
  PlayerPosition,
  Team,
} from './types';

/**
 * Maps raw player data to a more usable format
 */
export function mapPlayer(player: Player): {
  id: number;
  fullName: string;
  position: PlayerPosition;
  team: number;
  stats: {
    form: number;
    totalPoints: number;
    price: number;
    selectedBy: number;
  };
  status: {
    chanceOfPlaying: number | null;
    news: string;
  };
} {
  return {
    id: player.id,
    fullName: `${player.first_name} ${player.second_name}`,
    position: player.element_type,
    team: player.team,
    stats: {
      form: parseFloat(player.form),
      totalPoints: player.total_points,
      price: player.now_cost / 10, // Convert to actual price
      selectedBy: parseFloat(player.selected_by_percent),
    },
    status: {
      chanceOfPlaying: player.chance_of_playing_next_round,
      news: player.news,
    },
  };
}

/**
 * Maps raw team data to a more usable format
 */
export function mapTeam(team: Team): {
  id: number;
  name: string;
  shortName: string;
  strength: {
    overall: number;
    attack: { home: number; away: number };
    defense: { home: number; away: number };
  };
  form: number | null;
} {
  return {
    id: team.id,
    name: team.name,
    shortName: team.short_name,
    strength: {
      overall: team.strength,
      attack: {
        home: team.strength_attack_home,
        away: team.strength_attack_away,
      },
      defense: {
        home: team.strength_defence_home,
        away: team.strength_defence_away,
      },
    },
    form: team.form ? parseFloat(team.form) : null,
  };
}

/**
 * Maps raw event (gameweek) data to a more usable format
 */
export function mapEvent(event: Event): {
  id: number;
  name: string;
  deadlineTime: Date;
  finished: boolean;
  current: boolean;
  averageScore: number;
  highestScore: number;
  isCurrent: boolean;
  isNext: boolean;
} {
  return {
    id: event.id,
    name: event.name,
    deadlineTime: new Date(event.deadline_time),
    finished: event.finished,
    current: event.is_current,
    averageScore: event.average_entry_score,
    highestScore: event.highest_score,
    isCurrent: event.is_current,
    isNext: event.is_next,
  };
}

/**
 * Maps raw fixture data to a more usable format
 */
export function mapFixture(fixture: Fixture): {
  id: number;
  event: number;
  homeTeam: number;
  awayTeam: number;
  started: boolean;
  finished: boolean;
  kickoffTime: Date;
  score: {
    home: number | null;
    away: number | null;
  };
} {
  return {
    id: fixture.id,
    event: fixture.event,
    homeTeam: fixture.team_h,
    awayTeam: fixture.team_a,
    started: fixture.started,
    finished: fixture.finished,
    kickoffTime: new Date(fixture.kickoff_time),
    score: {
      home: fixture.team_h_score,
      away: fixture.team_a_score,
    },
  };
}

/**
 * Maps raw live event player data to a more usable format
 */
export function mapLiveEventPlayer(player: LiveEventPlayer): {
  id: number;
  stats: {
    minutes: number;
    totalPoints: number;
    goals: number;
    assists: number;
    cleanSheet: boolean;
    bonus: number;
  };
} {
  return {
    id: player.id,
    stats: {
      minutes: player.stats.minutes,
      totalPoints: player.stats.total_points,
      goals: player.stats.goals_scored,
      assists: player.stats.assists,
      cleanSheet: player.stats.clean_sheets > 0,
      bonus: player.stats.bonus,
    },
  };
}

/**
 * Maps bootstrap static response to domain models
 */
export function mapBootstrapStatic(data: BootstrapStaticResponse): {
  events: ReturnType<typeof mapEvent>[];
  teams: ReturnType<typeof mapTeam>[];
  players: ReturnType<typeof mapPlayer>[];
} {
  return {
    events: data.events.map(mapEvent),
    teams: data.teams.map(mapTeam),
    players: data.elements.map(mapPlayer),
  };
}

/**
 * Maps position ID to readable position name
 */
export function mapPlayerPosition(elementTypes: ElementType[]): Record<PlayerPosition, string> {
  return elementTypes.reduce(
    (acc, type) => ({
      ...acc,
      [type.id]: type.singular_name,
    }),
    {} as Record<PlayerPosition, string>,
  );
}

/**
 * Maps team ID to team name
 */
export function mapTeamIdToName(teams: Team[]): Record<number, string> {
  return teams.reduce(
    (acc, team) => ({
      ...acc,
      [team.id]: team.name,
    }),
    {} as Record<number, string>,
  );
}
