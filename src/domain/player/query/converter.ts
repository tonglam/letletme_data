import { ElementTypeConfig } from '../../../types/base.type';
import { Player } from '../../../types/player.type';
import { PlayerView } from '../../../types/player/query.type';
import { Team } from '../../../types/team.type';

export const buildPlayerView = (player: Player, team: Team): PlayerView => {
  const elementTypeInfo = ElementTypeConfig[player.elementType];
  return {
    ...player,
    elementType: elementTypeInfo.name,
    team: {
      id: Number(team.id),
      name: team.name,
      shortName: team.shortName,
    },
  };
};

export const buildPlayerViews = (players: Player[], teams: Map<number, Team>): PlayerView[] =>
  players.map((player) => {
    const team = teams.get(Number(player.teamId));
    if (!team) {
      throw new Error(`Team ${player.teamId} not found for player ${player.id}`);
    }
    return buildPlayerView(player, team);
  });
