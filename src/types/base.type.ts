// ================================
// Base Element/Position Types
// ================================

export type ElementTypeId = 1 | 2 | 3 | 4; // GKP=1, DEF=2, MID=3, FWD=4
export type ElementTypeName = 'GKP' | 'DEF' | 'MID' | 'FWD';

// Element type mapping
export const ELEMENT_TYPE_MAP: Record<ElementTypeId, ElementTypeName> = {
  1: 'GKP',
  2: 'DEF',
  3: 'MID',
  4: 'FWD',
} as const;

// Reverse mapping
export const ELEMENT_TYPE_ID_MAP: Record<ElementTypeName, ElementTypeId> = {
  GKP: 1,
  DEF: 2,
  MID: 3,
  FWD: 4,
} as const;

// ================================
// Domain ID Types (for consistency with existing project)
// ================================

// Reexport existing types with new aliases for player stats domain
export type { EventID as EventId, PlayerID as PlayerId, TeamID as TeamId } from './index';
