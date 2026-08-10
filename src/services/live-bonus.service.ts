import type { LiveBonusByTeam } from '../domain/live-bonus';
import type { TeamId } from '../types/base.type';

export function serializeBonusByTeam(source: Map<TeamId, Map<number, number>>): LiveBonusByTeam {
  const result: Record<string, Record<string, number>> = {};
  for (const [teamId, teamBonus] of source.entries()) {
    const values: Record<string, number> = {};
    for (const [elementId, bonus] of teamBonus.entries()) {
      values[String(elementId)] = bonus;
    }
    if (Object.keys(values).length > 0) {
      result[String(teamId)] = values;
    }
  }
  return result as LiveBonusByTeam;
}
