import { BootStrap } from '../../../constant/bootStrap.type';
import { Team, TeamSchema } from '../../../constant/teams.type';
import { prisma } from '../../../index';
import { safeDelete } from '../../base/mongoDB';
import { truncate_insert } from '../base';

const transformData = (data: Team) => ({
  id: undefined,
  team_id: data.id,
  team_code: data.code,
  name: data.name,
  short_name: data.short_name,
  win: data.win,
  draw: data.draw,
  loss: data.loss,
  played: data.played,
  points: data.points,
  position: data.position,
  strength: data.strength,
  strength_overall_home: data.strength_overall_home,
  strength_overall_away: data.strength_overall_away,
  strength_attack_home: data.strength_attack_home,
  strength_attack_away: data.strength_attack_away,
  strength_defence_home: data.strength_defence_home,
  strength_defence_away: data.strength_defence_away,
});

const upsertTeam = async (bootStrapData: BootStrap) => {
  await truncate_insert(
    bootStrapData.teams,
    TeamSchema,
    transformData,
    async () => {
      await safeDelete('team');
    },
    async (data) => {
      await prisma.team.createMany({ data });
    },
  );
};

export { upsertTeam };
