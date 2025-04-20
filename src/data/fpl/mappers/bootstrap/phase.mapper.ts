import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Phase, validatePhaseId } from 'src/types/domain/phase.type';

import { PhaseResponse } from '../../schemas/bootstrap/phase.schema';

export const mapPhaseResponseToPhase = (raw: PhaseResponse): E.Either<string, Phase> =>
  pipe(
    E.Do,
    E.bind('id', () => validatePhaseId(raw.id)),
    E.map((data) => {
      return {
        id: data.id,
        name: raw.name,
        startEvent: raw.start_event,
        stopEvent: raw.stop_event,
        highestScore: raw.highest_score,
      };
    }),
  );
