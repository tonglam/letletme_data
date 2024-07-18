import { fpl_api_config } from '../configs/api.config';
import { upsertEvent } from '../functions/upsertFunctions/upsertEvent';
import { getFetch } from '../utils/fetch.utils';

const upsertStaticData = async () => {
  const bootStrapData = await getFetch(fpl_api_config.BOOTSTRAP_STATIC_URL)()();
  if (!bootStrapData) {
    console.error('Error fetching bootstrap data');
    return;
  }

  // event data
  await upsertEvent(bootStrapData);
};

export { upsertStaticData };
