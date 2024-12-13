import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { right, left } from 'fp-ts/Either';
import dotenv from 'dotenv';
import { EventSyncService } from '../../../src/services/events/sync';
import { EventSchedulerService } from '../../../src/services/events/scheduler';
import { EventBootstrapService } from '../../../src/services/events/bootstrap';
import { 
  FPLEvent, 
  EventService,
  EventStatus,
  EventDetails
} from '../../../src/services/events/types';
import { RedisCache } from '../../../src/services/cache/redis';
import { PostgresTransaction } from '../../../src/services/db/postgres';

// Load environment variables
dotenv.config();

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_KEY;
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

// Check if required environment variables are set
const isConfigured = SUPABASE_URL && SUPABASE_ANON_KEY && REDIS_HOST && REDIS_PORT && REDIS_PASSWORD;

// Initialize services
let supabase: SupabaseClient;
let redisCache: RedisCache;
let eventService: EventService;
let postgresTransaction: PostgresTransaction;
let eventSyncService: EventSyncService;
let eventSchedulerService: EventSchedulerService;
let eventBootstrapService: EventBootstrapService;

// Mock FPL API functions
async function fetchFPLEvents(): Promise<FPLEvent[]> {
  // Mock data for all 38 gameweeks
  return Array.from({ length: 38 }, (_, index) => {
    const gameweekNumber = index + 1;
    const startTime = new Date('2024-08-10T14:00:00Z');
    const endTime = new Date('2024-08-10T16:00:00Z');
    
    // Add 7 days for each subsequent gameweek
    startTime.setDate(startTime.getDate() + (index * 7));
    endTime.setDate(endTime.getDate() + (index * 7));
    
    return {
      id: gameweekNumber,
      name: `Gameweek ${gameweekNumber}`,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      status: EventStatus.PENDING,
      details: {
        description: `Gameweek ${gameweekNumber} of the season`,
        metadata: {}
      }
    };
  });
}

async function fetchFPLEventDetails(eventId: number): Promise<EventDetails> {
  // Mock data with more realistic details
  return {
    description: `Gameweek ${eventId} of the 2024/25 season`,
    metadata: {
      averageScore: 0,
      highestScore: 0,
      chipPlays: [],
      mostCaptained: null,
      mostViceCaptained: null,
      mostSelected: null,
      mostTransferredIn: null,
      topElement: null,
      transfersMade: 0,
      cupLeaguesCreated: false,
      h2hKoMatchesCreated: false,
      rankedCount: 0
    }
  };
}

// Type for Prisma JSON input
type PrismaJsonValue = string | number | boolean | null | PrismaJsonInput | PrismaJsonInput[];
interface PrismaJsonInput {
  [key: string]: PrismaJsonValue;
}

// Convert unknown value to Prisma-compatible JSON value
function toPrismaJsonValue(value: unknown): PrismaJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

// Convert EventDetails to Prisma-compatible JSON
function toJsonInput(details: EventDetails): PrismaJsonInput {
  const metadata: PrismaJsonInput = {};
  for (const [key, value] of Object.entries(details.metadata)) {
    metadata[key] = toPrismaJsonValue(value);
  }
  return {
    description: details.description,
    metadata
  };
}

describe('Event Workflow Integration', () => {
  beforeAll(async () => {
    if (!isConfigured) {
      console.warn(
        'Skipping tests: Required environment variables are not set.',
        'Please set SUPABASE_URL and SUPABASE_KEY'
      );
      return;
    }

    // Initialize Supabase client with service role key
    supabase = createClient(
      SUPABASE_URL!,
      SUPABASE_ANON_KEY!,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        },
        global: {
          headers: {
            'apikey': SUPABASE_ANON_KEY!,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY!}`
          }
        }
      }
    );

    // Verify database connection
    const { error: connectionError } = await supabase
      .from('events')
      .select('count')
      .limit(1);

    if (connectionError) {
      console.error('Failed to connect to Supabase:', connectionError);
      throw connectionError;
    }
    console.log('Successfully connected to Supabase');

    // Set up table and policies
    console.log('Setting up table and policies...');
    try {
      // Create table if not exists
      const { error: tableError } = await supabase.from('events').select().limit(1);
      
      if (tableError) {
        console.error('Error checking table:', tableError);
        throw tableError;
      }

      // Commenting out the clear data operation to preserve existing data
      /*
      // Clear existing data
      const { error: clearError } = await supabase
        .from('events')
        .delete()
        .neq('id', 0);

      if (clearError) {
        if (clearError.code === 'PGRST204') {
          console.log('No data to clear');
        } else {
          console.error('Error clearing data:', clearError);
          throw clearError;
        }
      } else {
        console.log('Table cleared successfully');
      }
      */

    } catch (error) {
      console.error('Database setup error:', error);
      throw error;
    }

    // Initialize Redis cache
    redisCache = new RedisCache(`redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}`);
    await redisCache.clear();

    // Initialize Postgres transaction
    postgresTransaction = new PostgresTransaction(supabase);

    // Initialize event service with real implementations
    eventService = {
      initialize: async () => {
        try {
          // Commenting out clear events to preserve data
          /*const { error } = await supabase
            .from('events')
            .delete()
            .neq('id', 0);

          if (error) throw error;*/
          return right(undefined);
        } catch (error) {
          console.error('Failed to initialize:', error);
          throw error;
        }
      },

      syncEvents: async () => {
        try {
          const events = await fetchFPLEvents();
          console.log(`Fetched ${events.length} events from FPL API`);
          console.log('Event data:', JSON.stringify(events, null, 2));
          
          // Save events to Supabase
          console.log('Saving events to Supabase...');
          
          const results = await Promise.all(
            events.map(async event => {
              try {
                const eventData = {
                  id: event.id,
                  name: event.name,
                  deadline_time: event.startTime.toISOString(),
                  deadline_time_epoch: Math.floor(event.startTime.getTime() / 1000),
                  deadline_time_game_offset: 0,
                  release_time: event.endTime.toISOString(),
                  finished: false,
                  data_checked: false,
                  chip_plays: toJsonInput(event.details)
                };
                console.log('Attempting to insert event data:', JSON.stringify(eventData, null, 2));

                const { data, error } = await supabase
                  .from('events')
                  .upsert(eventData)
                  .select();

                if (error) {
                  console.error(`Error details for event ${event.id}:`, error);
                  throw error;
                }
                console.log('Successfully inserted event:', data);
                return null;
              } catch (error) {
                console.error(`Error saving event ${event.id}:`, error);
                return error instanceof Error ? error : new Error(String(error));
              }
            })
          );

          const errors = results.filter(result => result !== null);
          if (errors.length > 0) {
            console.error('Errors saving events:', errors);
            return left(new Error('Failed to save some events'));
          }

          console.log('Successfully saved events to Supabase');
          return right(events);
        } catch (error) {
          console.error('Failed to sync events:', error);
          return left(error instanceof Error ? error : new Error(String(error)));
        }
      },

      syncEventDetails: async (eventId: number) => {
        try {
          const { data: event, error: fetchError } = await supabase
            .from('events')
            .select('*')
            .eq('id', eventId)
            .single();

          if (fetchError) throw fetchError;
          if (!event) throw new Error(`Event ${eventId} not found`);

          // Fetch additional details from FPL API
          const details = await fetchFPLEventDetails(eventId);

          // Update event with details
          const { error: updateError } = await supabase
            .from('events')
            .update({
              chip_plays: toJsonInput(details)
            })
            .eq('id', eventId);

          if (updateError) throw updateError;

          // Return the updated event in FPLEvent format
          const fplEvent: FPLEvent = {
            id: event.id,
            name: event.name,
            startTime: new Date(event.deadline_time),
            endTime: new Date(event.release_time || event.deadline_time),
            status: EventStatus.PENDING,
            details
          };

          return right(fplEvent);
        } catch (error) {
          console.error('Failed to sync event details:', error);
          return left(error instanceof Error ? error : new Error(String(error)));
        }
      },

      verifyEventData: async (eventId: number) => {
        try {
          const { data, error } = await supabase
            .from('events')
            .select('id')
            .eq('id', eventId)
            .single();

          if (error) throw error;
          return right(!!data);
        } catch (error) {
          console.error('Failed to verify event data:', error);
          return left(error instanceof Error ? error : new Error(String(error)));
        }
      },

      scheduleEventUpdates: async () => {
        return right(undefined);
      },
    };

    // Initialize services
    eventSyncService = new EventSyncService(redisCache, postgresTransaction);
    eventSchedulerService = new EventSchedulerService(eventService, postgresTransaction);
    eventBootstrapService = new EventBootstrapService(eventService, postgresTransaction);
  });

  afterAll(async () => {
    if (!isConfigured) {
      return;
    }

    try {
      // Cleanup Redis only, keep Supabase data for verification
      if (redisCache) {
        await redisCache.clear();
        await redisCache.disconnect();
      }
      // Commenting out Supabase cleanup to verify data persistence
      /*if (supabase) {
        const { error } = await supabase
          .from('events')
          .delete()
          .neq('id', 0);

        if (error) throw error;
      }*/
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
  });

  test('should successfully complete entire event workflow', async () => {
    if (!isConfigured) {
      console.warn('Test skipped: Required environment variables are not set');
      return;
    }

    // Step 1: Initialize system
    console.log('Initializing system...');
    const initResult = await eventBootstrapService.initialize();
    expect(initResult._tag).toBe('Right');
    console.log('System initialized');

    // Step 2: Sync events
    console.log('Syncing events...');
    const syncResult = await eventService.syncEvents();
    expect(syncResult._tag).toBe('Right');
    console.log('Events synced');

    // Step 3: Verify events are synced
    console.log('Verifying events in database...');
    const { data: events, error } = await supabase
      .from('events')
      .select('*');

    if (error) throw error;

    if (!events || events.length === 0) {
      console.error('No events found in database');
      throw new Error('No events found in database');
    }

    console.log(`Found ${events.length} events in database`);
    if (events && events.length > 0) {
      console.log('First event:', events[0]);
    }

    expect(events).toBeDefined();
    expect(events.length).toBeGreaterThan(0);

    // Step 4: Test cache functionality
    if (events && events.length > 0) {
      const eventId = events[0].id;
      console.log('Testing cache functionality for event:', eventId);

      // First call should hit the database
      const firstCallResult = await eventSyncService.syncEventDetails(eventId);
      console.log('First call result:', firstCallResult);

      // Second call should hit the cache
      const secondCallResult = await eventSyncService.syncEventDetails(eventId);
      console.log('Second call result:', secondCallResult);

      // Results should be the same
      if (firstCallResult._tag === 'Right' && secondCallResult._tag === 'Right') {
        const first = firstCallResult.right;
        const second = {
          ...secondCallResult.right,
          startTime: new Date(secondCallResult.right.startTime),
          endTime: new Date(secondCallResult.right.endTime)
        };
        expect(first).toEqual(second);
      }

      // Step 5: Test scheduler
      const scheduleResult = await eventSchedulerService.scheduleEventUpdates();
      expect(scheduleResult._tag).toBe('Right');

      // Wait for one update cycle
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Verify data is still consistent
      const verifyResult = await eventService.verifyEventData(eventId);
      expect(verifyResult._tag).toBe('Right');
    }
  }, 30000); // Increase timeout for integration test
});
