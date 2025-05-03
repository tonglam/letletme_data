import * as E from 'fp-ts/Either';
import { z } from 'zod';

import { EventSchema } from './schema';

// --- Domain Model ---
export type Event = z.infer<typeof EventSchema>;
export type Events = Event[];

// --- Domain Factory ---
export const createEvent = (event: Event): E.Either<Error, Event> => {
  return E.right(event);
};

// --- Domain Logic ---
export const isEventActive = (event: Event): boolean =>
  !event.finished && event.deadlineTime > new Date();

export const isEventFinished = (event: Event): boolean => event.finished;
