import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Player } from '../../types/players.type';
import { PlayerCache } from './cache';
import { PlayerRepository } from './repository';

export const createPlayerService = (repository: PlayerRepository, cache: PlayerCache) => {
  const getPlayer = (id: number): TE.TaskEither<Error, Player> =>
    pipe(
      cache.get(id),
      TE.chain((cachedPlayer) =>
        cachedPlayer
          ? TE.right(cachedPlayer)
          : pipe(
              repository.findById(id),
              TE.chain((player) =>
                pipe(
                  cache.set(player),
                  TE.map(() => player),
                ),
              ),
            ),
      ),
    );

  const getAllPlayers = (): TE.TaskEither<Error, ReadonlyArray<Player>> =>
    pipe(
      repository.findAll(),
      TE.chain((players) =>
        pipe(
          cache.setMany(players),
          TE.map(() => players),
        ),
      ),
    );

  const updatePlayers = (players: ReadonlyArray<Player>): TE.TaskEither<Error, void> =>
    pipe(
      repository.upsertMany(players),
      TE.chain(() => cache.setMany(players)),
    );

  const updatePlayerValue = (id: number, price: number): TE.TaskEither<Error, void> =>
    pipe(
      repository.updateValue(id, price),
      TE.chain(() => cache.remove(id)),
    );

  const updatePlayerStats = (id: number, stats: Player): TE.TaskEither<Error, void> =>
    pipe(
      repository.updateStats(id, stats),
      TE.chain(() => cache.remove(id)),
    );

  const updatePlayersBatch = (
    players: ReadonlyArray<Player>,
    batchSize: number,
  ): TE.TaskEither<Error, void> => {
    const chunks = A.chunksOf(batchSize)([...players]); // Convert readonly array to mutable array
    return pipe(
      chunks,
      A.traverse(TE.ApplicativePar)((batch) => updatePlayers(batch)),
      TE.map(() => undefined),
    );
  };

  return {
    getPlayer,
    getAllPlayers,
    updatePlayers,
    updatePlayerValue,
    updatePlayerStats,
    updatePlayersBatch,
  } as const;
};

export type PlayerService = ReturnType<typeof createPlayerService>;
