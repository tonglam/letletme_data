import * as E from 'fp-ts/Either';

import {
  Branded,
  createBrandedType,
  ElementTypeId,
  ElementTypeName,
  ValueChangeType,
} from '../base.type';
import { TeamId } from './team.type';

export type PlayerValueId = Branded<number, 'PlayerValueId'>;

export const PlayerValueId = createBrandedType<number, 'PlayerValueId'>(
  'PlayerValueId',
  (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0,
);

export const validatePlayerValueIdInput = (value: unknown): E.Either<string, PlayerValueId> => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return E.left('Invalid player value ID: input must be a non-empty string');
  }
  const numericId = parseInt(value, 10);
  if (isNaN(numericId) || !Number.isInteger(numericId) || numericId <= 0) {
    return E.left(
      'Invalid player value ID: input must be a string representing a positive integer',
    );
  }
  return E.right(numericId as PlayerValueId);
};

export interface PlayerValue {
  readonly element: number;
  readonly elementType: ElementTypeId;
  readonly elementTypeName: ElementTypeName;
  readonly event: number;
  readonly team: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly value: number;
  readonly changeDate: string;
  readonly changeType: ValueChangeType;
  readonly lastValue: number;
}
export type PlayerValues = readonly PlayerValue[];

export type SourcePlayerValue = Omit<
  PlayerValue,
  | 'lastValue'
  | 'changeType'
  | 'elementType'
  | 'elementTypeName'
  | 'team'
  | 'teamName'
  | 'teamShortName'
>;
export type SourcePlayerValues = readonly SourcePlayerValue[];

export type PlayerValueChange = Omit<
  PlayerValue,
  'elementType' | 'elementTypeName' | 'team' | 'teamName' | 'teamShortName'
>;
export type PlayerValueChanges = readonly PlayerValueChange[];
