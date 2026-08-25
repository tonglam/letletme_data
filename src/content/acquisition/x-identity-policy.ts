import type { AdapterKind, SourceType } from './acquisition-profiles';

/**
 * Identity is a control-plane concern, not a proxy for whether an X handle is
 * allowed to be scanned.  Only the official FPL/league/club endpoints need a
 * numeric X user ID before they can run.  Other manifest handles are queried
 * by their persisted handle, while semantic discoveries remain observation
 * records until a later, explicit promotion.
 */
export const X_IDENTITY_REQUIREMENTS = [
  'REQUIRED',
  'HANDLE_ONLY',
  'DISCOVERED_ONLY',
  'NOT_APPLICABLE',
] as const;

export type XIdentityRequirement = (typeof X_IDENTITY_REQUIREMENTS)[number];
export type SourceOrigin = 'MANIFEST' | 'DISCOVERED';

export function resolveXIdentityRequirement(input: {
  adapterKind: AdapterKind;
  sourceType: SourceType;
  origin: SourceOrigin;
}): XIdentityRequirement {
  if (input.adapterKind !== 'X_ACCOUNT') return 'NOT_APPLICABLE';
  if (input.origin === 'DISCOVERED' || input.sourceType === 'DISCOVERED_UNKNOWN') {
    return 'DISCOVERED_ONLY';
  }
  if (
    input.sourceType === 'OFFICIAL_FPL' ||
    input.sourceType === 'LEAGUE_OFFICIAL' ||
    input.sourceType === 'CLUB_OFFICIAL'
  ) {
    return 'REQUIRED';
  }
  // Reporters, creators, publications, shows, aggregators and player-facing
  // official accounts are intentionally handle-only in the first layer.
  return 'HANDLE_ONLY';
}

export function xEndpointMayScan(input: {
  adapterKind: AdapterKind | string;
  identityRequirement: XIdentityRequirement | string;
  identityStatus: string;
}): boolean {
  if (input.adapterKind === 'X_ACCOUNT') {
    return (
      input.identityRequirement === 'HANDLE_ONLY' ||
      (input.identityRequirement === 'REQUIRED' && input.identityStatus === 'VERIFIED')
    );
  }
  if (input.adapterKind === 'X_SEMANTIC') {
    return input.identityRequirement === 'NOT_APPLICABLE' && input.identityStatus === 'VERIFIED';
  }
  // Non-X adapters keep their existing stable-identity gate.  This helper is
  // used by the shared scheduler, so do not make the X policy accidentally
  // defer configured YouTube channel endpoints.
  if (input.adapterKind === 'YOUTUBE_CHANNEL') {
    return input.identityStatus === 'VERIFIED';
  }
  return false;
}
