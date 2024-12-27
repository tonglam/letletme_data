import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createDomainOperations } from 'src/utils/domain';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import {
  Team as DomainTeam,
  PrismaTeam,
  TeamId,
  toDomainTeam,
  toPrismaTeam,
} from '../../types/teams.type';
import type { TeamCacheOperations } from './cache';
import { teamRepository } from './repository';

const { single, array } = createDomainOperations<DomainTeam, PrismaTeam>({
  toDomain: toDomainTeam,
  toPrisma: toPrismaTeam,
});

export const saveTeam = (team: DomainTeam): TE.TaskEither<APIError, DomainTeam> =>
  pipe(
    teamRepository.save(single.fromDomain(team)),
    TE.map(single.toDomain),
    TE.chain((result) =>
      result
        ? TE.right(result)
        : TE.left(createValidationError({ message: 'Failed to save team' })),
    ),
  );

export const cacheTeam =
  (cache: TeamCacheOperations) =>
  (team: DomainTeam): TE.TaskEither<APIError, void> =>
    pipe(
      cache.cacheTeam({ ...single.fromDomain(team), createdAt: new Date() }),
      TE.mapLeft((error) =>
        createValidationError({ message: 'Failed to cache team', details: { error } }),
      ),
    );

export const findAllTeams = (): TE.TaskEither<APIError, readonly DomainTeam[]> =>
  pipe(teamRepository.findAll(), TE.map(array.toDomain));

export const findTeamById = (id: TeamId): TE.TaskEither<APIError, DomainTeam | null> =>
  pipe(teamRepository.findById(id), TE.map(single.toDomain));

export const saveBatchTeams = (
  teams: readonly DomainTeam[],
): TE.TaskEither<APIError, readonly DomainTeam[]> =>
  pipe(
    teams,
    TE.of,
    TE.map(array.fromDomain),
    TE.chain((prismaTeams) => pipe(teamRepository.saveBatch(prismaTeams), TE.map(array.toDomain))),
  );
