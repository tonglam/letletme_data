import { BootStrap } from '../../../constant/bootStrap.type';
import { Element, ElementSchema } from '../../../constant/element.type';
import { safeCreateMany, safeDelete, truncate_insert } from '../base';

const transformData = (data: Element) => ({
  element_id: data.id,
  element_code: data.code,
  price: data.now_cost,
  start_price: data.now_cost - data.cost_change_start,
  element_type: data.element_type,
  first_name: data.first_name,
  second_name: data.second_name,
  web_name: data.web_name,
  team_id: data.team,
  id: undefined,
});

const upsertPlayer = async (bootStrapData: BootStrap) => {
  await truncate_insert(
    bootStrapData.elements,
    ElementSchema,
    transformData,
    async () => {
      await safeDelete('player');
    },
    async (data) => {
      await safeCreateMany('player', data);
    },
  );
};

export { upsertPlayer };
