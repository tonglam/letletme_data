import { EventId } from 'types/domain/event.type';
import { TeamId } from 'types/domain/team.type';

export type TeamFixture = {
  readonly eventId: EventId;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly teamScore: number;
  readonly teamDifficulty: number;
  readonly opponentTeamId: TeamId;
  readonly opponentTeamName: string;
  readonly opponentTeamShortName: string;
  readonly opponentTeamScore: number;
  readonly opponentTeamDifficulty: number;
  readonly kickoffTime: Date;
  readonly started: boolean;
  readonly finished: boolean;
  readonly minutes: number;
  readonly wasHome: boolean;
  readonly score: string;
  readonly result: string;
  readonly dgw: boolean;
  readonly bgw: boolean;
};

export type TeamFixtures = readonly TeamFixture[];
