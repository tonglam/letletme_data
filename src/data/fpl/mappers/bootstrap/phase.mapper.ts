import { PhaseResponse } from 'data/fpl/schemas/bootstrap/phase.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Phase, PhaseId, validatePhaseId } from 'types/domain/phase.type';

export const mapPhaseResponseToPhase = (raw: PhaseResponse): E.Either<string, Phase> =>
  pipe(
    E.Do,
    E.bind('id', () => validatePhaseId(raw.id)),
    E.map((data) => {
      return {
        id: data.id as PhaseId,
        name: raw.name,
        startEvent: raw.start_event,
        stopEvent: raw.stop_event,
        highestScore: raw.highest_score,
      };
    }),
  );
