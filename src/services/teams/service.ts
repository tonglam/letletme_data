import { isLeft, isRight } from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import { createError } from '../../domains/phases/operations';
import type { APIError } from '../../infrastructure/http/common/errors';
import type { TeamId, Teams } from '../../types/teams.type';
import {
  convertPrismaTeams,
  getCachedOrFallbackMany,
  getCachedOrFallbackOne,
  toDomainTeam,
  toPrismaTeam,
} from '../../types/teams.type';
import type { TeamService, TeamServiceDependencies } from './types';

const fetchBootstrapTeams = (api: BootstrapApi): TE.TaskEither<APIError, Teams> =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapData(),
      (error) => createError('Failed to fetch bootstrap data', error as Error),
    ),
    TE.chain((data) => {
      if (!data) {
        return TE.left(createError('Bootstrap data is null'));
      }

      if (!data.teams || data.teams.length === 0) {
        return TE.left(createError('No teams found in bootstrap data'));
      }

      const transformResults = data.teams.map((team) => toDomainTeam(team));
      const errors = transformResults.filter(isLeft).map((e) => e.left);

      if (errors.length > 0) {
        return TE.left(createError(`Failed to transform team data: ${errors.join(', ')}`));
      }

      const teams = transformResults.filter(isRight).map((r) => r.right);
      return TE.right(teams as Teams);
    }),
  );

export const createTeamServiceImpl = ({
  bootstrapApi,
  teamCache,
  teamRepository,
}: TeamServiceDependencies): TeamService => {
  const syncTeams = () =>
    pipe(
      fetchBootstrapTeams(bootstrapApi),
      TE.chain((teams) =>
        pipe(
          teamRepository.deleteAll(),
          TE.chain(() => teamRepository.saveBatch(teams.map(toPrismaTeam))),
          TE.chainFirst((savedTeams) =>
            teamCache
              ? pipe(
                  savedTeams,
                  TE.traverseArray((team) => teamCache.cacheTeam(team)),
                  TE.mapLeft((error) => createError('Failed to cache teams', error)),
                )
              : TE.right(undefined),
          ),
          TE.chain(convertPrismaTeams),
        ),
      ),
    );

  const getTeams = () =>
    getCachedOrFallbackMany(teamCache?.getAllTeams(), teamRepository.findAll());

  const getTeam = (id: TeamId) =>
    getCachedOrFallbackOne(teamCache?.getTeam(String(id)), teamRepository.findById(id));

  const getTeamByCode = (code: number) =>
    pipe(
      teamRepository.findByCode(code),
      TE.chain((team) =>
        team
          ? pipe(
              TE.right(team),
              TE.chain(convertPrismaTeam),
              TE.mapLeft((error) => createError('Failed to convert team', error)),
            )
          : TE.right(null),
      ),
    );

  return {
    syncTeams,
    getTeams,
    getTeam,
    getTeamByCode,
  };
};
