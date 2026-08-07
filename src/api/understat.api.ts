import { Elysia, t } from 'elysia';

import { enqueueUnderstatPlayerSync, enqueueUnderstatTeamSync } from '../jobs/understat-enqueue';
import type { ProviderLinkStatus } from '../domain/provider-identity';
import { providerIdentityRepository } from '../repositories/provider-identity';
import {
  manualVerifyProviderTeam,
  reconcileProviderMappings,
} from '../services/provider-matcher.service';
import { getUnderstatStatus } from '../services/understat-status.service';
import { assertUnderstatSyncAllowed } from '../services/understat-sync.service';

const SyncBody = t.Object({
  season: t.String({ pattern: '^\\d{4}$' }),
  mode: t.Union([t.Literal('incremental'), t.Literal('full'), t.Literal('reconcile')]),
  teamIds: t.Optional(t.Array(t.Integer({ minimum: 1 }), { minItems: 1, uniqueItems: true })),
  matchIds: t.Optional(t.Array(t.Integer({ minimum: 1 }), { minItems: 1, uniqueItems: true })),
});

const LinkStatus = t.Union([
  t.Literal('pending'),
  t.Literal('auto_verified'),
  t.Literal('manual_verified'),
  t.Literal('ambiguous'),
  t.Literal('quarantined'),
  t.Literal('rejected'),
  t.Literal('not_observed'),
]);

const ReviewStatus = t.Union([
  t.Literal('pending'),
  t.Literal('manual_verified'),
  t.Literal('quarantined'),
  t.Literal('rejected'),
]);

export const understatAPI = new Elysia({ prefix: '/understat' })
  .post(
    '/team/sync',
    async ({ body, set }) => {
      assertUnderstatSyncAllowed(body.season);
      const { job, runId } = await enqueueUnderstatTeamSync({
        season: body.season,
        mode: body.mode,
        trigger: 'api',
        teamIds: body.teamIds,
      });
      set.status = 202;
      return { success: true, lane: 'team', runId, jobId: job.id };
    },
    { body: SyncBody },
  )
  .post(
    '/player/sync',
    async ({ body, set }) => {
      assertUnderstatSyncAllowed(body.season);
      const { job, runId } = await enqueueUnderstatPlayerSync({
        season: body.season,
        mode: body.mode,
        trigger: 'api',
        teamIds: body.teamIds,
        matchIds: body.matchIds,
      });
      set.status = 202;
      return { success: true, lane: 'player', runId, jobId: job.id };
    },
    { body: SyncBody },
  )
  .get(
    '/status/:season',
    async ({ params }) => ({ success: true, ...(await getUnderstatStatus(params.season)) }),
    { params: t.Object({ season: t.String({ pattern: '^\\d{4}$' }) }) },
  )
  .post(
    '/mappings/team',
    async ({ body }) => {
      assertUnderstatSyncAllowed(body.season);
      const link = await manualVerifyProviderTeam(body);
      return { success: true, link };
    },
    {
      body: t.Object({
        season: t.String({ pattern: '^\\d{4}$' }),
        understatTeamId: t.Integer({ minimum: 1 }),
        fplTeamCode: t.Integer({ minimum: 1 }),
        reviewedBy: t.String({ minLength: 1, maxLength: 200 }),
      }),
    },
  )
  .post(
    '/mappings/reconcile',
    async ({ body }) => {
      assertUnderstatSyncAllowed(body.season);
      return { success: true, ...(await reconcileProviderMappings(body.season)) };
    },
    { body: t.Object({ season: t.String({ pattern: '^\\d{4}$' }) }) },
  )
  .get(
    '/mappings/:season',
    async ({ params, query }) => {
      const statuses = query.status ? ([query.status] as ProviderLinkStatus[]) : undefined;
      const [entityLinks, matchLinks] = await Promise.all([
        providerIdentityRepository.findEntityLinks({
          entityType: query.entityType,
          statuses,
        }),
        providerIdentityRepository.findMatchLinks({ season: params.season, statuses }),
      ]);
      return {
        success: true,
        season: params.season,
        entityLinks: entityLinks.filter(
          (link) =>
            (!link.firstSeenSeason || link.firstSeenSeason <= params.season) &&
            (!link.lastSeenSeason || link.lastSeenSeason >= params.season),
        ),
        matchLinks,
      };
    },
    {
      params: t.Object({ season: t.String({ pattern: '^\\d{4}$' }) }),
      query: t.Object({
        entityType: t.Optional(t.Union([t.Literal('team'), t.Literal('player')])),
        status: t.Optional(LinkStatus),
      }),
    },
  )
  .patch(
    '/mappings/entity/:id',
    async ({ params, body, set }) => {
      if (body.status === 'manual_verified' && !body.reviewedBy) {
        throw new Error('reviewedBy is required for manual verification');
      }
      const link = await providerIdentityRepository.updateEntityStatus(
        params.id,
        body.status,
        body.reviewedBy,
      );
      if (!link) {
        set.status = 404;
        return { success: false, error: 'Provider entity link not found' };
      }
      return { success: true, link };
    },
    {
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Object({
        status: ReviewStatus,
        reviewedBy: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
      }),
    },
  )
  .patch(
    '/mappings/match/:id',
    async ({ params, body, set }) => {
      if (body.status === 'manual_verified' && !body.reviewedBy) {
        throw new Error('reviewedBy is required for manual verification');
      }
      const link = await providerIdentityRepository.updateMatchStatus(
        params.id,
        body.status,
        body.reviewedBy,
      );
      if (!link) {
        set.status = 404;
        return { success: false, error: 'Provider match link not found' };
      }
      return { success: true, link };
    },
    {
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Object({
        status: ReviewStatus,
        reviewedBy: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
      }),
    },
  );
