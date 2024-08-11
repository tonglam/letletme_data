import { fpl_api_config } from '../configs/api.config';
import { upsertEvent } from '../functions/upsert/bootstrap/event';
import { upsertPhase } from '../functions/upsert/bootstrap/phase';
import { upsertPlayer } from '../functions/upsert/bootstrap/player';
import { upsertPlayerStat } from '../functions/upsert/bootstrap/playerStat';
import { upsertPlayerValue } from '../functions/upsert/bootstrap/playerValue';
import { upsertTeam } from '../functions/upsert/bootstrap/team';
import { getFetch } from '../utils/fetch.utils';

const upsertStaticData = async () => {
  const bootStrapData = await getFetch(fpl_api_config.BOOTSTRAP_STATIC_URL)()();
  if (!bootStrapData) {
    console.error('Error fetching bootstrap data');
    return;
  }

  // event data
  await upsertEvent(bootStrapData);

  // phase data
  await upsertPhase(bootStrapData);

  // team data
  await upsertTeam(bootStrapData);

  // player data
  await upsertPlayer(bootStrapData);

  // player stat data
  await upsertPlayerStat(bootStrapData);

  // player value data
  await upsertPlayerValue(bootStrapData);
};

export { upsertStaticData };
