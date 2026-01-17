#!/usr/bin/env bun
/**
 * Script to create missing database tables
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../src/db/singleton';

async function createTables() {
  console.log('🔧 Creating missing database tables...\n');

  try {
    const db = await getDb();

    // Create event_live_summaries table
    console.log('Creating event_live_summaries table...');
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS event_live_summaries (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id),
        element_id INTEGER NOT NULL REFERENCES players(id),
        element_type INTEGER NOT NULL,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        minutes INTEGER DEFAULT 0 NOT NULL,
        goals_scored INTEGER DEFAULT 0 NOT NULL,
        assists INTEGER DEFAULT 0 NOT NULL,
        clean_sheets INTEGER DEFAULT 0 NOT NULL,
        goals_conceded INTEGER DEFAULT 0 NOT NULL,
        own_goals INTEGER DEFAULT 0 NOT NULL,
        penalties_saved INTEGER DEFAULT 0 NOT NULL,
        penalties_missed INTEGER DEFAULT 0 NOT NULL,
        yellow_cards INTEGER DEFAULT 0 NOT NULL,
        red_cards INTEGER DEFAULT 0 NOT NULL,
        saves INTEGER DEFAULT 0 NOT NULL,
        bonus INTEGER DEFAULT 0 NOT NULL,
        bps INTEGER DEFAULT 0 NOT NULL,
        total_points INTEGER DEFAULT 0 NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_event_live_summary_element 
      ON event_live_summaries(element_id)
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_event_live_summary_event_id 
      ON event_live_summaries(event_id)
    `);

    console.log('✅ event_live_summaries table created\n');

    console.log('🎉 All tables created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating tables:', error);
    process.exit(1);
  }
}

createTables();
