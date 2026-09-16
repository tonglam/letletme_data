import { and, desc, eq } from 'drizzle-orm';
import { fplClient, PicksResponseSchema, EntryHistoryCurrentItemSchema } from '../clients/fpl';
import { getDb } from '../db/singleton';
import { dataGovernanceCasesInOps } from '../db/schemas/index.schema';
import type { DbEntryEventResult } from '../db/schemas/platform.types';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEntryEventPicksResponse } from '../types';
import {
  exactTimestamp,
  publishEntryLiveInputV2,
  readEntryLiveInputV2,
  setEntryCheckpointDesiredV2,
  validateEntryLiveInputV2,
  type EntryLiveInputV2,
} from '../cache/live-publication-v2';
import {
  createEntryEventPicksRepository,
  entryEventPicksRepository,
} from '../repositories/entry-event-picks';
import { createEntryEventResultsRepository } from '../repositories/entry-event-results';
import { createEntryInfoRepository, entryInfoRepository } from '../repositories/entry-infos';
import { createEventRepository, eventRepository } from '../repositories/events';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import { withEntrySeasonSyncTransaction } from '../repositories/entry-event-transfers';
import { contentHash } from '../utils/content-hash';
import {
  buildFinalEntryLiveInputFromBaseAndResult,
  checkpointEntryLiveInputV2,
  hasFinalEntryCheckpoint,
  normalizeFinalPicks,
  normalizeFinalAutomaticSubs,
} from './entries.service';
import { openGovernanceCase, updateGovernanceCaseStatus } from './data-governance.service';

type HistoryRow = Awaited<ReturnType<typeof fplClient.getEntryHistory>>['current'][number];
type Identity = { entryName: string; playerName: string; overallRank: number | null };

/** Only the known deleted-entry zero-total defect is eligible, never a score/pick correction. */
export function buildDeletedEntryFinalCorrection(input: {
  original: EntryLiveInputV2;
  result: DbEntryEventResult;
  identity: Identity;
  picks: RawFPLEntryEventPicksResponse;
  history: HistoryRow;
  dataCheckedAt: Date | string;
}): EntryLiveInputV2 {
  const { original, result, identity, picks, history, dataCheckedAt } = input;
  const scope = { season: original.season, eventId: result.eventId, entryId: result.entryId };
  if (
    !validateEntryLiveInputV2(original, scope) ||
    !original.finalResult ||
    identity.entryName.trim() !== 'Deleted' ||
    identity.playerName.trim() !== 'Deleted Player' ||
    identity.overallRank !== 0 ||
    result.overallRank !== 0 ||
    result.eventRank !== 0 ||
    result.overallPoints !== 0 ||
    original.finalResult.score.totalPoints !== result.eventPoints ||
    result.eventPoints <= 0 ||
    original.finalResult.score.eventPoints !== result.eventPoints ||
    picks.entry_history.event !== result.eventId ||
    history.event !== result.eventId
  ) {
    throw new Error('FINAL correction is not the proven deleted-entry cumulative-total defect');
  }
  for (const observed of [picks.entry_history, history]) {
    if (
      observed.total_points !== 0 ||
      observed.overall_rank !== 0 ||
      (observed.rank !== null && observed.rank !== 0) ||
      observed.points !== result.eventPoints ||
      observed.event_transfers_cost !== result.eventTransfersCost
    ) {
      throw new Error('Independent official sources do not confirm the zero-total correction');
    }
  }
  const normalizeChip = (chip: string | null | undefined) =>
    !chip || chip.toLowerCase() === 'n/a' ? null : chip.toLowerCase();
  const frozenChip = normalizeChip(original.picksBase.chip);
  const expected = normalizeFinalPicks(result.eventPicks, result.entryId, result.eventId);
  const official = normalizeFinalPicks(picks.picks, result.entryId, result.eventId);
  const frozen = normalizeFinalPicks(original.finalResult.picks, result.entryId, result.eventId);
  if (
    !expected ||
    !official ||
    !frozen ||
    contentHash(expected) !== contentHash(official) ||
    contentHash(expected) !== contentHash(frozen) ||
    normalizeChip(picks.active_chip) !== frozenChip ||
    normalizeChip(result.eventChip) !== frozenChip
  ) {
    throw new Error('FINAL correction cannot change picks or chip');
  }
  const elements = new Set(expected.map((pick) => pick.element));
  const normalizeSubs = (value: unknown) => {
    const subs = normalizeFinalAutomaticSubs(value, elements);
    return subs?.sort((a, b) => a.inElement - b.inElement || a.outElement - b.outElement);
  };
  const durableSubs = normalizeSubs(result.automaticSubstitutions);
  const officialSubs = normalizeSubs(picks.automatic_subs);
  const frozenSubs = normalizeSubs(original.finalResult.automaticSubs);
  if (
    !durableSubs ||
    !officialSubs ||
    !frozenSubs ||
    contentHash(durableSubs) !== contentHash(officialSubs) ||
    contentHash(durableSubs) !== contentHash(frozenSubs)
  ) {
    throw new Error('FINAL correction cannot change automatic substitutions');
  }
  const corrected = buildFinalEntryLiveInputFromBaseAndResult(
    { ...original, finalResult: null },
    result,
    dataCheckedAt,
  );
  if (!corrected) throw new Error('Corrected FINAL does not satisfy the finalized result contract');
  return corrected;
}

export async function correctDeletedEntryFinal(input: {
  season: FplSeasonRef;
  entryId: number;
  eventId: number;
  expectedPublicationId: string;
  expectedGeneration: number;
  changeId: string;
  apply: boolean;
}) {
  const { season, entryId, eventId } = input;
  if (
    ![entryId, eventId, input.expectedGeneration].every((n) => Number.isSafeInteger(n) && n > 0) ||
    eventId > 38 ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(input.changeId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      input.expectedPublicationId,
    )
  )
    throw new Error('Invalid explicit correction target');
  const fingerprint = contentHash({
    season: season.seasonCode,
    entryId,
    eventId,
    expectedPublicationId: input.expectedPublicationId,
    expectedGeneration: input.expectedGeneration,
    changeId: input.changeId,
  });
  const db = await getDb();
  const [existingCase] = await db
    .select()
    .from(dataGovernanceCasesInOps)
    .where(
      and(
        eq(dataGovernanceCasesInOps.caseKind, 'entry-final-correction'),
        eq(dataGovernanceCasesInOps.fingerprint, fingerprint),
      ),
    )
    .orderBy(desc(dataGovernanceCasesInOps.caseId))
    .limit(1);
  if (existingCase && !['REQUIRES_REVIEW', 'RECOVERED'].includes(existingCase.status)) {
    throw new Error('Correction audit is not eligible for explicit recovery');
  }
  const event = await eventRepository.findById(season, eventId);
  const boundary = await eventRepository.findDataCheckedAtExact(season, eventId);
  if (!event?.finished || !event.dataChecked || !boundary)
    throw new Error('Event is not finalized');
  const [head, results, identities, current] = await Promise.all([
    entryEventPicksRepository.findHead(season, entryId, eventId),
    createEntryEventResultsRepository().findByEventAndEntryIds(season, eventId, [entryId]),
    entryInfoRepository.findByIds(season, [entryId]),
    readEntryLiveInputV2({ season: season.seasonCode, eventId, entryId }),
  ]);
  if (
    !head ||
    !results[0] ||
    !identities[0] ||
    !current ||
    current.servedFrom !== 'REDIS_CURRENT' ||
    current.publication.state !== 'FINAL' ||
    !hasFinalEntryCheckpoint(season, eventId, head, boundary)
  ) {
    throw new Error('Correction requires a validated durable FINAL and current Redis publication');
  }
  const evidence = existingCase?.evidence as Record<string, unknown> | undefined;
  const original = (evidence?.originalInput ?? head.inputPayload) as EntryLiveInputV2;
  if (
    !evidence &&
    (head.publicationId !== input.expectedPublicationId ||
      head.generation !== input.expectedGeneration ||
      current.publication.publicationId !== head.publicationId ||
      current.publication.generation !== head.generation ||
      contentHash(current.input) !== contentHash(original))
  ) {
    throw new Error('Explicit correction target no longer matches the durable/current FINAL');
  }
  // A persisted correction is its own source evidence. Retrying its checkpoint
  // must not require the deleted account's endpoints to remain available.
  let source: { exact: string };
  let picks: RawFPLEntryEventPicksResponse;
  let historyRow: HistoryRow;
  if (evidence) {
    if (evidence.dataCheckedAt !== boundary)
      throw new Error('Audited finalization boundary changed');
    source = { exact: exactTimestamp(String(evidence.observedAt)) };
    picks = PicksResponseSchema.parse(evidence.providerPicks);
    historyRow = EntryHistoryCurrentItemSchema.parse(evidence.providerHistory);
  } else {
    // Provider waits precede all mutation and audit writes.
    source = await readDatabaseOrderingTimestamp();
    const observed = await Promise.all([
      fplClient.getEntryEventPicks(entryId, eventId),
      fplClient.getEntryHistory(entryId),
    ]);
    picks = observed[0];
    const history = observed[1].current.find((row) => row.event === eventId);
    if (!history) throw new Error('Official history is missing the requested event');
    historyRow = history;
  }
  const corrected = buildDeletedEntryFinalCorrection({
    original,
    result: results[0],
    identity: identities[0],
    picks,
    history: historyRow,
    dataCheckedAt: boundary,
  });
  const correctionHash = contentHash(corrected);
  const alreadyPublished = contentHash(current.input) === correctionHash;
  if (
    !alreadyPublished &&
    (current.publication.publicationId !== input.expectedPublicationId ||
      current.publication.generation !== input.expectedGeneration ||
      contentHash(current.input) !== contentHash(original))
  ) {
    throw new Error('Another FINAL publication superseded this correction');
  }
  const headIsOriginal =
    head.publicationId === input.expectedPublicationId &&
    head.generation === input.expectedGeneration &&
    contentHash(head.inputPayload) === contentHash(original);
  const headIsCorrected =
    alreadyPublished &&
    head.publicationId === current.publication.publicationId &&
    head.generation === current.publication.generation &&
    contentHash(head.inputPayload) === correctionHash;
  if (!headIsOriginal && !headIsCorrected)
    throw new Error('Durable FINAL correction identity changed');
  const receipt = {
    eventId,
    changeId: input.changeId,
    originalPublicationId: input.expectedPublicationId,
    originalGeneration: input.expectedGeneration,
    oldTotal: original.finalResult!.score.totalPoints,
    correctedTotal: 0,
    eventPoints: results[0].eventPoints,
    correctionHash,
    alreadyPublished,
  };
  if (!input.apply) return { mode: 'inspect', ...receipt };
  // Persist the complete original evidence before any cache pointer can change.
  const audit =
    existingCase ??
    (await openGovernanceCase({
      caseKind: 'entry-final-correction',
      contractKey: 'entry-live-v2',
      lane: 'entry-sync',
      scopeKey: `${season.seasonCode}:event:${eventId}:entry:${entryId}`,
      targetRevision: input.expectedPublicationId,
      fingerprint,
      errorClass: 'DATA_INCOMPLETE',
      errorCode: 'DELETED_ENTRY_FINAL_TOTAL_CORRECTION',
      compensator: 'explicit audited deleted-entry FINAL correction',
      requiresReview: true,
      evidence: JSON.parse(
        JSON.stringify({
          changeId: input.changeId,
          originalInput: original,
          originalHead: head,
          correctionHash,
          dataCheckedAt: boundary,
          observedAt: source.exact,
          providerHistory: historyRow,
          providerPicks: picks,
          acceptedResult: results[0],
        }),
      ),
      repairTarget: { eventId, entryId },
    }));
  if (!audit || (audit.evidence as Record<string, unknown>).correctionHash !== correctionHash)
    throw new Error('Durable correction evidence is missing or changed');
  // Serialize canonical revalidation and promotion with the existing entry writer fence.
  // HTTP reads are complete before entering this short transaction; checkpointing
  // reacquires the same fence after it, so it must not run inside this callback.
  const publication = await withEntrySeasonSyncTransaction(
    season,
    entryId,
    async (tx) => {
      const currentBoundary = await createEventRepository(tx).findDataCheckedAtExact(
        season,
        eventId,
        { lock: 'share' },
      );
      const [freshResult] = await createEntryEventResultsRepository(tx).findByEventAndEntryIds(
        season,
        eventId,
        [entryId],
      );
      const [freshIdentity] = await createEntryInfoRepository(tx).findByIds(season, [entryId]);
      const freshHead = await createEntryEventPicksRepository(tx).findHead(
        season,
        entryId,
        eventId,
      );
      if (
        currentBoundary !== boundary ||
        !freshResult ||
        !freshIdentity ||
        contentHash(freshResult) !== contentHash(results[0]) ||
        freshIdentity.entryName !== identities[0].entryName ||
        freshIdentity.playerName !== identities[0].playerName ||
        freshIdentity.overallRank !== 0 ||
        !freshHead ||
        freshHead.publicationId !== head.publicationId ||
        freshHead.generation !== head.generation ||
        contentHash(freshHead.inputPayload) !== contentHash(head.inputPayload)
      )
        throw new Error('Canonical result or FINAL identity changed during correction');
      if (alreadyPublished) return current.publication;
      return (
        await publishEntryLiveInputV2({
          season: season.seasonCode,
          eventId,
          entryId,
          input: corrected,
          sourceCheckedAt: source.exact,
          preserveSourceCheckedAtPrecision: true,
          generationFloor: head.generation,
          finalizationCorrectionBoundary: source.exact,
          expectedCurrentPublication: {
            publicationId: input.expectedPublicationId,
            generation: input.expectedGeneration,
            contentSha256: current.publication.item.sha256,
          },
        })
      ).publication;
    },
    { timeoutMs: 5000 },
  );
  await setEntryCheckpointDesiredV2(publication);
  if ((await checkpointEntryLiveInputV2(season, eventId, entryId)) !== 'checkpointed')
    throw new Error('Corrected FINAL still requires durable checkpoint recovery');
  await withEntrySeasonSyncTransaction(
    season,
    entryId,
    async (tx) => {
      const acceptedBoundary = await createEventRepository(tx).findDataCheckedAtExact(
        season,
        eventId,
        { lock: 'share' },
      );
      const accepted = await readEntryLiveInputV2({ season: season.seasonCode, eventId, entryId });
      const acceptedHead = await createEntryEventPicksRepository(tx).findHead(
        season,
        entryId,
        eventId,
      );
      const [acceptedResult] = await createEntryEventResultsRepository(tx).findByEventAndEntryIds(
        season,
        eventId,
        [entryId],
      );
      const acceptedInput = acceptedResult
        ? buildDeletedEntryFinalCorrection({
            original,
            result: acceptedResult,
            identity: identities[0]!,
            picks,
            history: historyRow,
            dataCheckedAt: boundary,
          })
        : null;
      if (
        acceptedBoundary !== boundary ||
        !accepted ||
        accepted.servedFrom !== 'REDIS_CURRENT' ||
        contentHash(accepted.input) !== correctionHash ||
        accepted.publication.publicationId !== publication.publicationId ||
        !acceptedHead ||
        acceptedHead.publicationId !== publication.publicationId ||
        acceptedHead.generation !== publication.generation ||
        contentHash(acceptedHead.inputPayload) !== correctionHash ||
        !acceptedInput ||
        contentHash(acceptedInput) !== correctionHash ||
        !hasFinalEntryCheckpoint(season, eventId, acceptedHead, boundary)
      )
        throw new Error('Corrected FINAL identity failed final verification');
      if (
        audit.status !== 'RECOVERED' &&
        !(await updateGovernanceCaseStatus({
          caseId: audit.caseId,
          expectedUpdatedAt: audit.updatedAt,
          status: 'RECOVERED',
          recoveryRevision: publication.publicationId,
          db: tx,
        }))
      )
        throw new Error('Correction audit settlement lost its identity');
    },
    { timeoutMs: 5000 },
  );
  return {
    mode: 'applied',
    ...receipt,
    caseId: audit.caseId,
    publicationId: publication.publicationId,
    generation: publication.generation,
  };
}
