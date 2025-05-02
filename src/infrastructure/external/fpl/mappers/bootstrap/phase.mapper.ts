import { PhaseID, validatePhaseId } from '@app/domain/types/id.types';
import { PhaseResponse } from '@app/infrastructure/external/fpl/schemas/bootstrap/phase.schema';
import { Phase } from '@app/shared/types/domain/phase.type';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapPhaseResponseToPhase = (raw: PhaseResponse): E.Either<string, Phase> =>
  pipe(
    E.Do,
    E.bind('id', () => validatePhaseId(raw.id)),
    E.map((data) => {
      return {
        id: data.id as PhaseID,
        name: raw.name,
        startEvent: raw.start_event,
        stopEvent: raw.stop_event,
        highestScore: raw.highest_score,
      };
    }),
  );
