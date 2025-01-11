import * as TE from 'fp-ts/TaskEither';
import { ElementType } from '../base.type';
import { DomainError } from '../error.type';
import { PlayerId } from './base.type';

/**
 * Command model representing the write-side of player data
 */
export interface Player {
  readonly id: PlayerId;
  readonly elementCode: number;
  readonly price: number;
  readonly startPrice: number;
  readonly elementType: ElementType;
  readonly firstName: string | null;
  readonly secondName: string | null;
  readonly webName: string;
  readonly teamId: number;
}

export type Players = readonly Player[];

/**
 * Required fields for player creation:
 * - id (element) from the API
 * - elementCode (unique identifier)
 * - elementType (position)
 * - webName (display name)
 * - teamId (team association)
 *
 * Optional fields with defaults:
 * - price (defaults to 0)
 * - startPrice (defaults to 0)
 * - firstName (defaults to null)
 * - secondName (defaults to null)
 */
export type PlayerCreate = {
  readonly id: PlayerId;
  readonly elementCode: number;
  readonly elementType: ElementType;
  readonly webName: string;
  readonly teamId: number;
  readonly price?: number;
  readonly startPrice?: number;
  readonly firstName?: string | null;
  readonly secondName?: string | null;
};

/**
 * Updatable fields:
 * - price (current value)
 * - firstName (player's first name)
 * - secondName (player's last name)
 * - webName (display name)
 * - teamId (team association)
 *
 * Non-updatable fields (must be set at creation):
 * - id/element (primary key)
 * - elementCode (unique identifier)
 * - elementType (position)
 * - startPrice (initial value)
 */
export type PlayerUpdate = {
  readonly id: PlayerId;
} & Partial<Pick<Player, 'price' | 'firstName' | 'secondName' | 'webName' | 'teamId'>>;

/**
 * Command interface for write operations
 */
export interface PlayerCommand {
  readonly createPlayer: (data: PlayerCreate) => TE.TaskEither<DomainError, void>;
  readonly updatePlayer: (data: PlayerUpdate) => TE.TaskEither<DomainError, void>;
  readonly updatePrice: (id: PlayerId, price: number) => TE.TaskEither<DomainError, void>;
  readonly deletePlayer: (id: PlayerId) => TE.TaskEither<DomainError, void>;
  readonly saveBatch: (players: readonly PlayerCreate[]) => TE.TaskEither<DomainError, void>;
  readonly updatePrices: (
    updates: readonly { id: PlayerId; price: number }[],
  ) => TE.TaskEither<DomainError, void>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}
