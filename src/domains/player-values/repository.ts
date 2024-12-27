import { APIError, createDatabaseError } from '@infrastructure/errors';
import { PrismaClient } from '@prisma/client';
import { PlayerValue, PlayerValuesResponse, toDomainPlayerValue } from '@types/playerValues.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createPlayerValuesRepository = (prisma: PrismaClient) => {
  const findByPlayerId = (
    playerId: number,
    eventId: number,
  ): TE.TaskEither<APIError, ReadonlyArray<PlayerValue>> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            where: { elementId: playerId, eventId },
            orderBy: { changeDate: 'desc' },
          }),
        (error) => createDatabaseError({ message: `Failed to fetch player values: ${error}` }),
      ),
      TE.map((values) => values as ReadonlyArray<PlayerValue>),
    );

  const findLatestByPlayerId = (playerId: number): TE.TaskEither<APIError, PlayerValue | null> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findFirst({
            where: { elementId: playerId },
            orderBy: { changeDate: 'desc' },
          }),
        (error) =>
          createDatabaseError({ message: `Failed to fetch latest player value: ${error}` }),
      ),
      TE.map((value) => (value ? (value as PlayerValue) : null)),
    );

  const upsertValue = (value: PlayerValue): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.upsert({
            where: {
              elementId_changeDate: {
                elementId: value.elementId,
                changeDate: value.changeDate,
              },
            },
            create: value as any,
            update: value as any,
          }),
        (error) => createDatabaseError({ message: `Failed to upsert player value: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  const upsertMany = (values: ReadonlyArray<PlayerValue>): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.$transaction(
            values.map((value) =>
              prisma.playerValue.upsert({
                where: {
                  elementId_changeDate: {
                    elementId: value.elementId,
                    changeDate: value.changeDate,
                  },
                },
                create: value as any,
                update: value as any,
              }),
            ),
          ),
        (error) => createDatabaseError({ message: `Failed to upsert player values: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  const processValuesResponse = (
    response: PlayerValuesResponse,
    eventId: number,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      response,
      TE.traverseArray((item) =>
        pipe(
          findLatestByPlayerId(item.id),
          TE.chain((lastValue) =>
            toDomainPlayerValue(
              item,
              eventId,
              lastValue?.value || 0,
              new Date().toISOString(),
              lastValue && item.now_cost > lastValue.value ? 'INCREASE' : 'DECREASE',
            ),
          ),
        ),
      ),
      TE.chain(upsertMany),
    );

  return {
    findByPlayerId,
    findLatestByPlayerId,
    upsertValue,
    upsertMany,
    processValuesResponse,
  } as const;
};
export type PlayerValuesRepository = ReturnType<typeof createPlayerValuesRepository>;
