import { fpl_api_config } from '../config/fpl_api.config';
import { upsertEvents } from '../functions/upsert/bootstrap/events';
import { upsertPhases } from '../functions/upsert/bootstrap/phases';
import { upsertPlayer } from '../functions/upsert/bootstrap/players';
import { upsertTeams } from '../functions/upsert/bootstrap/teams';
import { getFetch } from '../utils/fetch.utils';

const upsertStaticData = async () => {
  const bootStrapData = await getFetch(fpl_api_config.BOOTSTRAP_STATIC_URL)()();
  if (!bootStrapData) {
    console.error('Error fetching bootstrap data');
    return;
  }

  await upsertEvents(bootStrapData);

  await upsertPhases(bootStrapData);

  await upsertTeams(bootStrapData);

  await upsertPlayer(bootStrapData);

  // await upsertPlayerStat(bootStrapData);

  // await upsertPlayerValue(bootStrapData);
};

export { upsertStaticData };
