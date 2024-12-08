import * as O from 'fp-ts/Option';
import { PlayerValueOperations } from '../../../src/domains/players/operations';
import { PlayerValueResponse } from '../../../src/domains/players/types';

describe('PlayerValueOperations', () => {
  describe('transformToPlayerValue', () => {
    const mockResponse: PlayerValueResponse = {
      id: 1,
      element_type: 2,
      now_cost: 100,
    };

    it('should return None when value has not changed', () => {
      const result = PlayerValueOperations.transformToPlayerValue(mockResponse, 100, 1);
      expect(O.isNone(result)).toBe(true);
    });

    it('should return Start type for new player', () => {
      const result = PlayerValueOperations.transformToPlayerValue(mockResponse, 0, 1);
      expect(O.isSome(result)).toBe(true);
      if (O.isSome(result)) {
        expect(result.value.changeType).toBe('Start');
        expect(result.value.lastValue).toBe(0);
      }
    });

    it('should return Rise type when value increases', () => {
      const result = PlayerValueOperations.transformToPlayerValue(mockResponse, 90, 1);
      expect(O.isSome(result)).toBe(true);
      if (O.isSome(result)) {
        expect(result.value.changeType).toBe('Rise');
        expect(result.value.lastValue).toBe(90);
      }
    });

    it('should return Fall type when value decreases', () => {
      const result = PlayerValueOperations.transformToPlayerValue(mockResponse, 110, 1);
      expect(O.isSome(result)).toBe(true);
      if (O.isSome(result)) {
        expect(result.value.changeType).toBe('Fall');
        expect(result.value.lastValue).toBe(110);
      }
    });
  });
});
