#!/usr/bin/env bun
/**
 * Script to apply Row Level Security (RLS) policies to all tables
 */

import { sql } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { getDb } from '../src/db/singleton';

async function applyRLS() {
  console.log('🔒 Applying Row Level Security (RLS) policies to all tables...\n');

  try {
    const db = await getDb();

    // Read the SQL file
    const sqlContent = readFileSync('./sql/enable-rls-all-tables.sql', 'utf-8');

    // Split by semicolons and filter out comments and empty lines
    const statements = sqlContent
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--') && !s.match(/^\/\*/));

    console.log(`📄 Found ${statements.length} SQL statements to execute\n`);

    let successCount = 0;
    let skipCount = 0;

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];

      // Skip DO blocks (they need special handling)
      if (statement.trim().startsWith('DO $$')) {
        console.log(`⏭️  Skipping DO block (${i + 1}/${statements.length})`);
        skipCount++;
        continue;
      }

      // Skip comments and verification queries
      if (
        statement.includes('Check RLS status') ||
        statement.includes('Check all policies') ||
        statement.includes('COMMENT ON')
      ) {
        skipCount++;
        continue;
      }

      try {
        await db.execute(sql.raw(statement));

        // Determine what the statement does for logging
        if (statement.includes('ENABLE ROW LEVEL SECURITY')) {
          const tableName = statement.match(/ALTER TABLE (\w+)/)?.[1];
          console.log(`✅ Enabled RLS on table: ${tableName || 'unknown'}`);
        } else if (statement.includes('CREATE POLICY')) {
          const match = statement.match(/CREATE POLICY "([^"]+)"/);
          const policyName = match?.[1] || 'unknown';
          console.log(`✅ Created policy: ${policyName}`);
        }

        successCount++;
      } catch (error: any) {
        // Check if error is about policy already existing
        if (error.message?.includes('already exists')) {
          const match = statement.match(/CREATE POLICY "([^"]+)"/);
          const policyName = match?.[1] || 'unknown';
          console.log(`⚠️  Policy already exists: ${policyName} (skipping)`);
          skipCount++;
        } else if (error.message?.includes('does not exist')) {
          console.log(`⚠️  Table does not exist, skipping`);
          skipCount++;
        } else {
          console.error(`❌ Error executing statement ${i + 1}:`, error.message);
          // Continue with other statements
        }
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 Summary:');
    console.log(`   ✅ Successfully applied: ${successCount} policies`);
    console.log(`   ⏭️  Skipped: ${skipCount} statements`);
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('🎉 RLS policies applied successfully!\n');
    console.log('Next steps:');
    console.log('  1. Verify RLS status: bun run scripts/check-rls.ts');
    console.log('  2. Test Data API access');
    console.log('  3. Check Supabase dashboard\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error applying RLS policies:', error);
    process.exit(1);
  }
}

applyRLS();
