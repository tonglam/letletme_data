import { BootStrap } from '../../../constant/bootStrap.type';
import { Team, TeamResponse, TeamResponseSchema } from '../../../constant/teams.type';
import { prisma } from '../../../lib/prisma';
import { truncate_insert } from '../base';

const transformData = (data: TeamResponse): Team => ({
  id: data.id,
  code: data.code,
  name: data.name,
  shortName: data.short_name,
  strength: data.strength,
  strengthOverallHome: data.strength_overall_home,
  strengthOverallAway: data.strength_overall_away,
  strengthAttackHome: data.strength_attack_home,
  strengthAttackAway: data.strength_attack_away,
  strengthDefenceHome: data.strength_defence_home,
  strengthDefenceAway: data.strength_defence_away,
  pulseId: data.pulse_id,
  played: data.played ?? 0,
  position: data.position ?? 0,
  points: data.points ?? 0,
  form: data.form,
  win: data.win ?? 0,
  draw: data.draw ?? 0,
  loss: data.loss ?? 0,
  teamDivision: data.team_division,
  unavailable: data.unavailable ?? false,
});

const upsertTeam = async (bootStrapData: BootStrap): Promise<void> => {
  await truncate_insert(
    bootStrapData.teams,
    TeamResponseSchema,
    transformData,
    async () => {
      await prisma.team.deleteMany();
    },
    async (data) => {
      await prisma.team.createMany({ data });
    },
  );
};

export { upsertTeam };
