import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';

type NamedFinding = { name: string };

describe('Database trust boundary', () => {
  test('keeps every public table fail-closed behind service-owned APIs', async () => {
    const sql = await getDbClient();

    const clientRoles = await sql<NamedFinding[]>`
      SELECT role_name AS name
      FROM (VALUES ('anon'), ('authenticated')) expected(role_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = expected.role_name)
    `;
    expect(
      clientRoles.map((finding) => finding.name),
      'Supabase client roles must exist before security migrations run',
    ).toEqual([]);

    const tablesWithoutRls = await sql<NamedFinding[]>`
      SELECT format('%I.%I', namespace.nspname, relation.relname) AS name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND NOT relation.relrowsecurity
      ORDER BY name
    `;
    expect(tablesWithoutRls.map((finding) => finding.name)).toEqual([]);

    const policies = await sql<NamedFinding[]>`
      SELECT format('%I.%I:%I', schemaname, tablename, policyname) AS name
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY name
    `;
    expect(policies.map((finding) => finding.name)).toEqual([]);

    const clientTableGrants = await sql<NamedFinding[]>`
      SELECT format('%s:%I.%I', client.role_name, namespace.nspname, relation.relname) AS name
      FROM (VALUES ('anon'), ('authenticated')) client(role_name)
      CROSS JOIN pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm')
        AND (
          has_table_privilege(client.role_name, relation.oid, 'SELECT')
          OR has_table_privilege(client.role_name, relation.oid, 'INSERT')
          OR has_table_privilege(client.role_name, relation.oid, 'UPDATE')
          OR has_table_privilege(client.role_name, relation.oid, 'DELETE')
        )
      ORDER BY name
    `;
    expect(clientTableGrants.map((finding) => finding.name)).toEqual([]);

    const clientSequenceGrants = await sql<NamedFinding[]>`
      SELECT format('%s:%I.%I', client.role_name, namespace.nspname, relation.relname) AS name
      FROM (VALUES ('anon'), ('authenticated')) client(role_name)
      CROSS JOIN pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind = 'S'
        AND (
          has_sequence_privilege(client.role_name, relation.oid, 'USAGE')
          OR has_sequence_privilege(client.role_name, relation.oid, 'SELECT')
          OR has_sequence_privilege(client.role_name, relation.oid, 'UPDATE')
        )
      ORDER BY name
    `;
    expect(clientSequenceGrants.map((finding) => finding.name)).toEqual([]);

    const clientFunctionGrants = await sql<NamedFinding[]>`
      SELECT format('%s:%I.%I(%s)', client.role_name, namespace.nspname, routine.proname,
                    pg_get_function_identity_arguments(routine.oid)) AS name
      FROM (VALUES ('anon'), ('authenticated')) client(role_name)
      CROSS JOIN pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'
        AND has_function_privilege(client.role_name, routine.oid, 'EXECUTE')
      ORDER BY name
    `;
    expect(clientFunctionGrants.map((finding) => finding.name)).toEqual([]);
  });
});
