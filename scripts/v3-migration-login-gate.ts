export type MigrationLoginSnapshot = {
  readonly roleName: string;
  readonly sessionUser: string;
  readonly serverMajor: number;
  readonly canLogin: boolean;
  readonly createRole: boolean;
  readonly inherit: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly migrationState: 'preactivation' | 'building' | 'activated';
  readonly publicRelationCount: number;
  readonly publicFunctionCount: number;
  readonly publicEnumCount: number;
  readonly wrongPublicOwnerCount: number;
  readonly publicLeagueTrendsCatalogState: 'absent' | 'valid' | 'invalid';
  readonly publicLeagueTrendsCatalogRows: number;
  readonly publicLeagueTrendsCatalogOrphans: number;
  readonly graphqlMainlineFunctionsValid: boolean;
  readonly invalidPreactivationSchemaCount: number;
  readonly preactivationSchemaObjectCount: number;
  readonly inheritedRoles: readonly string[];
  readonly canWriteMigrationLedger: boolean;
};

export function assertV3MigrationLoginSnapshot(snapshot: MigrationLoginSnapshot): void {
  if (snapshot.serverMajor !== 15) {
    throw new Error('Data Platform v3 migration requires PostgreSQL 15');
  }
  if (snapshot.roleName !== 'postgres' || snapshot.sessionUser !== snapshot.roleName) {
    throw new Error('V3 production migration requires the direct Supabase postgres LOGIN');
  }
  if (!snapshot.canLogin || !snapshot.createRole || !snapshot.inherit || !snapshot.bypassRls) {
    throw new Error('Supabase postgres migration LOGIN capabilities are incomplete');
  }
  if (snapshot.inheritedRoles.includes('letletme_v2_frozen_owner')) {
    throw new Error('Migration LOGIN must not inherit the frozen v2 owner');
  }

  if (snapshot.migrationState !== 'activated') {
    const acceptedPublicBaseline =
      (snapshot.publicRelationCount === 220 &&
        snapshot.publicFunctionCount === 6 &&
        snapshot.publicLeagueTrendsCatalogState === 'absent' &&
        snapshot.publicLeagueTrendsCatalogRows === 0 &&
        snapshot.publicLeagueTrendsCatalogOrphans === 0 &&
        !snapshot.graphqlMainlineFunctionsValid) ||
      (snapshot.publicRelationCount === 221 &&
        snapshot.publicFunctionCount === 8 &&
        snapshot.publicLeagueTrendsCatalogState === 'valid' &&
        snapshot.publicLeagueTrendsCatalogOrphans === 0 &&
        snapshot.graphqlMainlineFunctionsValid);

    if (
      !acceptedPublicBaseline ||
      snapshot.publicEnumCount !== 20 ||
      snapshot.wrongPublicOwnerCount !== 0
    ) {
      throw new Error('Pre-activation public ownership or exact B0 object scope is invalid');
    }
  }

  if (snapshot.migrationState === 'preactivation') {
    if (
      snapshot.invalidPreactivationSchemaCount !== 0 ||
      snapshot.preactivationSchemaObjectCount !== 0
    ) {
      throw new Error('Pre-activation v3 schema scope or ownership is invalid');
    }
    if (snapshot.inheritedRoles.includes('letletme_data_owner')) {
      throw new Error('Pre-activation migration LOGIN unexpectedly inherits the v3 owner');
    }
    return;
  }

  if (!snapshot.inheritedRoles.includes('letletme_data_owner')) {
    throw new Error('In-progress v3 migration LOGIN cannot SET ROLE to the v3 owner');
  }
  if (snapshot.migrationState === 'activated' && !snapshot.canWriteMigrationLedger) {
    throw new Error('Activated migration LOGIN cannot write the authoritative migration ledger');
  }
}
