import { fpl_api_config } from '../configs/api.config';
import { getFetch } from '../utils/fetch.utils';
import { upsertEvent } from './upsertDbService';

const upsertStaticData = async () => {
  const bootStrapData = await getFetch(fpl_api_config.BOOTSTRAP_STATIC_URL)()();
  if (!bootStrapData) {
    console.error('Error fetching bootstrap data');
    return;
  }

  await upsertEvent(bootStrapData);
};

export { upsertStaticData };
