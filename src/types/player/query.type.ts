import * as TE from 'fp-ts/TaskEither';
import { DomainError } from '../error.type';
import { PlayerId } from '../player.type';

/**
 * View model for player data with enriched team information.
 * This is the single source of truth for enriched player data,
 * used both in the query side of CQRS and service layer.
 */
export interface PlayerView {
  readonly id: PlayerId;
  readonly elementCode: number;
  readonly price: number;
  readonly startPrice: number;
  readonly elementType: string;
  readonly firstName: string | null;
  readonly secondName: string | null;
  readonly webName: string;
  readonly team: {
    readonly id: number;
    readonly name: string;
    readonly shortName: string;
  };
}

export type PlayerViews = readonly PlayerView[];

/**
 * Query interface for retrieving player data
 */
export interface PlayerQuery {
  readonly getPlayer: (id: PlayerId) => TE.TaskEither<DomainError, PlayerView | null>;
  readonly getAllPlayers: () => TE.TaskEither<DomainError, PlayerViews>;
  readonly getPlayersByTeam: (teamId: number) => TE.TaskEither<DomainError, PlayerViews>;
  readonly getPlayersByElementType: (
    elementType: string,
  ) => TE.TaskEither<DomainError, PlayerViews>;
}
