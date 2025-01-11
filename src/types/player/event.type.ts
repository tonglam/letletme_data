import * as TE from 'fp-ts/TaskEither';
import { DomainError } from '../error.type';
import { PlayerId } from './base.type';
import { PlayerCreate, PlayerUpdate } from './command.type';

/**
 * Event types for player domain
 */
export type PlayerEvent =
  | { type: 'PLAYER_CREATED'; payload: PlayerCreate }
  | { type: 'PLAYER_UPDATED'; payload: PlayerUpdate }
  | { type: 'PLAYER_DELETED'; payload: { id: PlayerId } }
  | { type: 'PLAYER_PRICE_CHANGED'; payload: { id: PlayerId; price: number } }
  | { type: 'PLAYERS_CREATED'; payload: readonly PlayerCreate[] }
  | { type: 'PLAYERS_DELETED'; payload: void }
  | { type: 'PLAYERS_PRICES_UPDATED'; payload: readonly { id: PlayerId; price: number }[] };

/**
 * Event handler interface for processing player events
 */
export interface PlayerEventHandler {
  readonly handle: (event: PlayerEvent) => TE.TaskEither<DomainError, void>;
}

/**
 * Event bus interface for publishing player events
 */
export interface PlayerEventBus {
  readonly publish: (event: PlayerEvent) => TE.TaskEither<DomainError, void>;
  readonly subscribe: (handler: PlayerEventHandler) => void;
}
