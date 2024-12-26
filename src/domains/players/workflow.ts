import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createDatabaseError } from '../../infrastructure/api/common/errors';
import { Player, PlayerResponse, transformPlayerResponse } from '../../types/players.type';
import { PlayerService } from './service';

export const createPlayerWorkflow = (service: PlayerService) => {
  const processPlayers = (responses: ReadonlyArray<PlayerResponse>): TE.TaskEither<Error, void> =>
    pipe(
      responses,
      TE.traverseArray((response) => pipe(transformPlayerResponse(response), TE.fromEither)),
      TE.chain((players) => service.updatePlayersBatch(players, 100)),
    );

  const processPlayerValue = (id: number, response: PlayerResponse): TE.TaskEither<Error, void> =>
    pipe(
      transformPlayerResponse(response),
      E.map((player) => player.price),
      TE.fromEither,
      TE.chain((price) => service.updatePlayerValue(id, price)),
    );

  const processPlayerStats = (id: number, response: PlayerResponse): TE.TaskEither<Error, void> =>
    pipe(
      transformPlayerResponse(response),
      TE.fromEither,
      TE.chain((stats) => service.updatePlayerStats(id, stats)),
    );

  const getPlayerDetails = (id: number): TE.TaskEither<Error, Player> =>
    pipe(
      service.getPlayer(id),
      TE.mapLeft((error) =>
        createDatabaseError({ message: `Failed to get player details: ${error}` }),
      ),
    );

  const getAllPlayerDetails = (): TE.TaskEither<Error, ReadonlyArray<Player>> =>
    pipe(
      service.getAllPlayers(),
      TE.mapLeft((error) =>
        createDatabaseError({ message: `Failed to get all player details: ${error}` }),
      ),
    );

  return {
    processPlayers,
    processPlayerValue,
    processPlayerStats,
    getPlayerDetails,
    getAllPlayerDetails,
  } as const;
};

export type PlayerWorkflow = ReturnType<typeof createPlayerWorkflow>;
