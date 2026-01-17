#!/usr/bin/env bun
/**
 * Script to check Row Level Security (RLS) status on all tables
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../src/db/singleton';

async function checkRLS() {
  console.log('🔍 Checking Row Level Security (RLS) status...\n');

  try {
    const db = await getDb();

    // Check which tables have RLS enabled
    const tablesResult = await db.execute(sql`
      SELECT 
        tablename,
        rowsecurity AS rls_enabled
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    const tables = Array.isArray(tablesResult) ? tablesResult : tablesResult.rows || [];

    console.log('📋 Tables RLS Status:');
    console.log('═══════════════════════════════════════════════════════════\n');

    let enabledCount = 0;
    let disabledCount = 0;

    for (const table of tables as any[]) {
      const status = table.rls_enabled ? '✅ ENABLED' : '❌ DISABLED';
      const padding = ' '.repeat(40 - table.tablename.length);
      console.log(`  ${table.tablename}${padding}${status}`);

      if (table.rls_enabled) {
        enabledCount++;
      } else {
        disabledCount++;
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 Summary:');
    console.log(`   ✅ RLS Enabled:  ${enabledCount} tables`);
    console.log(`   ❌ RLS Disabled: ${disabledCount} tables`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Check policies
    const policiesResult = await db.execute(sql`
      SELECT 
        tablename,
        policyname,
        cmd AS operation,
        roles
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `);

    const policies = Array.isArray(policiesResult) ? policiesResult : policiesResult.rows || [];

    if (policies.length > 0) {
      console.log('🔐 RLS Policies:');
      console.log('═══════════════════════════════════════════════════════════\n');

      let currentTable = '';
      for (const policy of policies as any[]) {
        if (policy.tablename !== currentTable) {
          if (currentTable) console.log('');
          console.log(`📁 ${policy.tablename}:`);
          currentTable = policy.tablename;
        }

        const roles = Array.isArray(policy.roles) ? policy.roles.join(', ') : policy.roles;
        console.log(`   • ${policy.policyname}`);
        console.log(`     Operation: ${policy.operation} | Roles: ${roles}`);
      }

      console.log('\n═══════════════════════════════════════════════════════════');
      console.log(`📊 Total Policies: ${policies.length}`);
      console.log('═══════════════════════════════════════════════════════════\n');
    } else {
      console.log('⚠️  No RLS policies found!\n');
    }

    if (disabledCount > 0) {
      console.log('⚠️  WARNING: Some tables still have RLS disabled!');
      console.log('   Run: bun run scripts/apply-rls.ts\n');
    } else {
      console.log('🎉 All tables have RLS enabled! ✅\n');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error checking RLS status:', error);
    process.exit(1);
  }
}

checkRLS();
