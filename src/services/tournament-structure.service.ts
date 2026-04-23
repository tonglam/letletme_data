import { getDbClient } from '../db/singleton';
import {
  buildGroupRows,
  buildKnockoutRows,
  seedBracketEntries,
  sortEntrySeeds,
  type EntrySeed,
  type TournamentConfig,
} from '../domain/tournament';

export async function rebuildTournamentStructure(
  tournament: TournamentConfig,
  entrySeeds: EntrySeed[],
): Promise<void> {
  const entryIds = sortEntrySeeds(entrySeeds).map((entry) => entry.entryId);
  const shouldSeedRoundOneImmediately =
    tournament.knockoutMode !== 'no_knockout' && tournament.groupMode === 'no_group';
  const seededRoundOne =
    shouldSeedRoundOneImmediately && tournament.knockoutTeamNum
      ? seedBracketEntries(entryIds, tournament.knockoutTeamNum)
      : null;
  const groupRows =
    tournament.groupMode === 'points_races' ? buildGroupRows(tournament, entrySeeds) : [];
  const knockoutRows =
    tournament.knockoutMode === 'no_knockout'
      ? { matches: [], results: [] }
      : buildKnockoutRows(tournament, seededRoundOne);

  const client = await getDbClient();
  await client.begin(async (tx) => {
    await tx`delete from tournament_knockout_results where tournament_id = ${tournament.id}`;
    await tx`delete from tournament_knockouts where tournament_id = ${tournament.id}`;
    await tx`delete from tournament_points_group_results where tournament_id = ${tournament.id}`;
    await tx`delete from tournament_battle_group_results where tournament_id = ${tournament.id}`;
    await tx`delete from tournament_groups where tournament_id = ${tournament.id}`;

    if (groupRows.length > 0) {
      await tx`
        insert into tournament_groups ${tx(
          groupRows,
          'tournament_id',
          'group_id',
          'group_name',
          'group_index',
          'entry_id',
          'started_event_id',
          'ended_event_id',
          'group_points',
          'group_rank',
          'played',
          'won',
          'drawn',
          'lost',
          'total_points',
          'total_transfers_cost',
          'total_net_points',
          'qualified',
          'overall_rank',
        )}
      `;
    }

    if (knockoutRows.matches.length > 0) {
      await tx`
        insert into tournament_knockouts ${tx(
          knockoutRows.matches,
          'tournament_id',
          'round',
          'started_event_id',
          'ended_event_id',
          'match_id',
          'next_match_id',
          'home_entry_id',
          'away_entry_id',
        )}
      `;
    }

    if (knockoutRows.results.length > 0) {
      await tx`
        insert into tournament_knockout_results ${tx(
          knockoutRows.results,
          'tournament_id',
          'event_id',
          'match_id',
          'play_against_id',
          'home_entry_id',
          'away_entry_id',
        )}
      `;
    }
  });
}
