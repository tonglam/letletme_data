import { Either, left, right } from 'fp-ts/Either';
import { Phase, PhaseResponse, toDomainPhase } from '../../types/phase.type';

interface PhaseOperationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Transform validated API response to domain model
 */
export const transformRawPhase = (raw: PhaseResponse): Either<string, Phase> => toDomainPhase(raw);

/**
 * Validate phase business rules
 */
export const validatePhase = (phase: Phase): Either<string, Phase> => {
  if (phase.startEvent > phase.stopEvent) {
    return left('Invalid phase: Start event ID cannot be greater than stop event ID');
  }

  if (!phase.name.trim()) {
    return left('Invalid phase: Name cannot be empty');
  }

  return right(phase);
};

/**
 * Create operation result
 */
export const createResult = <T>(data?: T, error?: string): PhaseOperationResult<T> => ({
  success: !error,
  data,
  error,
});
