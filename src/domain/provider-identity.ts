export type ProviderEntityType = 'team' | 'player';
export type ProviderLinkStatus =
  | 'pending'
  | 'auto_verified'
  | 'manual_verified'
  | 'ambiguous'
  | 'quarantined'
  | 'rejected';

export interface ProviderEntityLink {
  id: string;
  entityType: ProviderEntityType;
  leftProvider: string;
  leftEntityId: string | null;
  rightProvider: string;
  rightEntityId: string;
  status: ProviderLinkStatus;
  method: string;
  ruleId: string;
  evidence: Record<string, unknown>;
  firstSeenSeason: string | null;
  lastSeenSeason: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

export interface ProviderMatchLink {
  id: string;
  season: string;
  leftProvider: string;
  leftMatchId: string;
  rightProvider: string;
  rightMatchId: string;
  status: ProviderLinkStatus;
  method: string;
  ruleId: string;
  evidence: Record<string, unknown>;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

export const VERIFIED_PROVIDER_LINK_STATUSES: readonly ProviderLinkStatus[] = [
  'auto_verified',
  'manual_verified',
];

export function isVerifiedProviderLinkStatus(status: ProviderLinkStatus): boolean {
  return status === 'auto_verified' || status === 'manual_verified';
}
