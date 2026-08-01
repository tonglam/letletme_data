import { getCurrentEvent } from '../../../src/services/events.service';
import { ensureEvents } from './reference-data';

/** Return FPL's current event after seeding events, or null during valid preseason windows. */
export async function resolveCurrentEvent() {
  await ensureEvents();
  return getCurrentEvent();
}
