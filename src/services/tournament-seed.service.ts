import {
  seedBracketEntries,
  sortEntrySeeds,
  sortQualifiedEntries,
  type SeedPair,
} from '../domain/tournament';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { tournamentKnockoutsRepository } from '../repositories/tournament-knockouts';
import { tournamentKnockoutResultsRepository } from '../repositories/tournament-knockout-results';

export async function seedRoundOne(
  tournamentId: number,
  seededPairs: ReadonlyArray<SeedPair>,
  playAgainstNum: number,
): Promise<void> {
  if (seededPairs.length === 0) {
    return;
  }

  const roundOneMatches = await tournamentKnockoutsRepository.findRoundOne(tournamentId);
  if (roundOneMatches.length === 0) {
    return;
  }

  const matchUpdates: Array<{ matchId: number; pair: SeedPair }> = [];
  const resultUpdates: Array<{
    matchId: number;
    playAgainstId: number;
    pair: SeedPair;
  }> = [];

  for (let index = 0; index < roundOneMatches.length; index += 1) {
    const pair = seededPairs[index];
    if (!pair) {
      continue;
    }
    const matchId = roundOneMatches[index].matchId;
    matchUpdates.push({ matchId, pair });

    for (let leg = 0; leg < playAgainstNum; leg += 1) {
      const swap = leg % 2 === 1;
      resultUpdates.push({
        matchId,
        playAgainstId: leg + 1,
        pair: {
          homeEntryId: swap ? pair.awayEntryId : pair.homeEntryId,
          awayEntryId: swap ? pair.homeEntryId : pair.awayEntryId,
        },
      });
    }
  }

  await tournamentKnockoutsRepository.seedRoundOneBulk(tournamentId, matchUpdates);
  await tournamentKnockoutResultsRepository.seedRoundOneResultsBulk(tournamentId, resultUpdates);
}

export async function ensureKnockoutRoundOneSeeded(tournamentId: number): Promise<void> {
  const tournament = await tournamentInfoRepository.findSetupConfig(tournamentId);
  if (
    !tournament ||
    tournament.knockoutMode === 'no_knockout' ||
    !tournament.knockoutTeamNum ||
    !tournament.knockoutPlayAgainstNum
  ) {
    return;
  }

  const roundOne = await tournamentKnockoutsRepository.findRoundOne(tournamentId);
  if (roundOne.length === 0) {
    return;
  }

  const alreadySeeded = roundOne.every(
    (row) => row.homeEntryId !== null && row.awayEntryId !== null,
  );
  if (alreadySeeded) {
    return;
  }

  let seededEntryIds: number[] = [];

  if (tournament.groupMode === 'no_group') {
    const entrySeeds =
      await tournamentEntryRepository.findEntrySeedsByTournamentId(tournamentId);
    seededEntryIds = sortEntrySeeds(entrySeeds)
      .slice(0, tournament.knockoutTeamNum)
      .map((entry) => entry.entryId);
  } else {
    const qualifiedEntries =
      await tournamentEntryRepository.findQualifiedEntriesByTournamentId(tournamentId);
    if (qualifiedEntries.length < tournament.knockoutTeamNum) {
      return;
    }
    seededEntryIds = sortQualifiedEntries(qualifiedEntries)
      .slice(0, tournament.knockoutTeamNum)
      .map((entry) => entry.entryId);
  }

  if (seededEntryIds.length < tournament.knockoutTeamNum) {
    return;
  }

  await seedRoundOne(
    tournamentId,
    seedBracketEntries(seededEntryIds, tournament.knockoutTeamNum),
    tournament.knockoutPlayAgainstNum,
  );
}
