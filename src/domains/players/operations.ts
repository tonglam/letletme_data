import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createDomainOperations } from '../../infrastructure/db/operations';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import { ElementResponse } from '../../types/elements.type';
import {
  Player as DomainPlayer,
  PlayerId,
  PrismaPlayer,
  fromElementResponse,
  toDomainPlayer,
  toPrismaPlayer,
} from '../../types/players.type';
import type { PlayerCacheOperations } from './cache';
import { playerRepository } from './repository';

const { single, array } = createDomainOperations<DomainPlayer, PrismaPlayer>({
  toDomain: toDomainPlayer,
  toPrisma: toPrismaPlayer,
});

export const savePlayer = (player: DomainPlayer): TE.TaskEither<APIError, DomainPlayer> =>
  pipe(
    playerRepository.save(single.fromDomain(player)),
    TE.map(single.toDomain),
    TE.chain((result) =>
      result
        ? TE.right(result)
        : TE.left(createValidationError({ message: 'Failed to save player' })),
    ),
  );

export const cachePlayer =
  (cache: PlayerCacheOperations) =>
  (player: DomainPlayer): TE.TaskEither<APIError, void> =>
    pipe(
      cache.setPlayer(Number(player.id), player),
      TE.mapLeft((error) =>
        createValidationError({ message: 'Failed to cache player', details: { error } }),
      ),
    );

export const findAllPlayers = (): TE.TaskEither<APIError, readonly DomainPlayer[]> =>
  pipe(playerRepository.findAll(), TE.map(array.toDomain));

export const findPlayerById = (id: PlayerId): TE.TaskEither<APIError, DomainPlayer | null> =>
  pipe(playerRepository.findById(id), TE.map(single.toDomain));

export const saveBatchPlayers = (
  players: readonly DomainPlayer[],
): TE.TaskEither<APIError, readonly DomainPlayer[]> =>
  pipe(
    players,
    TE.of,
    TE.map(array.fromDomain),
    TE.chain((prismaPlayers) =>
      pipe(playerRepository.saveBatch(prismaPlayers), TE.map(array.toDomain)),
    ),
  );

// Bootstrap operations
export const processBootstrapPlayers = (
  data: readonly ElementResponse[],
): TE.TaskEither<APIError, void> =>
  pipe(
    data,
    TE.traverseArray((response) =>
      pipe(
        fromElementResponse(response),
        TE.fromEither,
        TE.mapLeft((error) =>
          createValidationError({
            message: 'Failed to transform player response',
            details: { error },
          }),
        ),
      ),
    ),
    TE.chain((players) => saveBatchPlayers(players)),
    TE.map(() => undefined),
  );
