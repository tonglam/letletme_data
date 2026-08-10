export type MigrationLoginSnapshot = {
  readonly roleName: string;
  readonly sessionUser: string;
  readonly serverMajor: number;
  readonly canLogin: boolean;
  readonly createRole: boolean;
  readonly inherit: boolean;
  readonly bypassRls: boolean;
  readonly hasOpsLedger: boolean;
  readonly canWriteMigrationLedger: boolean;
  readonly canonicalSchemaOwnerCount: number;
  readonly publicApplicationObjectCount: number;
  readonly cutoverTableCount: number;
  readonly frozenOwnerExists: boolean;
  readonly inheritedRoles: readonly string[];
};

export function assertMigrationLoginSnapshot(snapshot: MigrationLoginSnapshot): void {
  if (snapshot.serverMajor !== 15) {
    throw new Error('Platform migration requires PostgreSQL 15');
  }
  if (snapshot.roleName !== 'postgres' || snapshot.sessionUser !== snapshot.roleName) {
    throw new Error('Production migration requires the direct Supabase postgres LOGIN');
  }
  if (!snapshot.canLogin || !snapshot.createRole || !snapshot.inherit || !snapshot.bypassRls) {
    throw new Error('Supabase postgres migration LOGIN capabilities are incomplete');
  }
  if (!snapshot.hasOpsLedger || !snapshot.canWriteMigrationLedger) {
    throw new Error('Migration LOGIN cannot access the authoritative ledger');
  }
  if (snapshot.canonicalSchemaOwnerCount !== 6) {
    throw new Error('Canonical application schemas do not share the expected owner');
  }
  if (snapshot.publicApplicationObjectCount !== 0) {
    throw new Error('The public schema still contains application objects');
  }
  if (snapshot.cutoverTableCount !== 0 || snapshot.frozenOwnerExists) {
    throw new Error('Completed cutover state is still present');
  }
  if (!snapshot.inheritedRoles.includes('letletme_data_owner')) {
    throw new Error('Migration LOGIN cannot SET ROLE to the Data owner');
  }
  if (snapshot.inheritedRoles.includes('letletme_v2_frozen_owner')) {
    throw new Error('Migration LOGIN still inherits the retired frozen owner');
  }
}
