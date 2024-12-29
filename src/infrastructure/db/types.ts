/**
 * Database Types Module
 *
 * Core types and interfaces for database operations.
 */

import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Transaction context interface
 */
export interface TransactionContext {
  /** Active transaction state */
  isActive: boolean;

  /** Starts a transaction */
  start(): Promise<void>;

  /** Commits a transaction */
  commit(): Promise<void>;

  /** Rolls back a transaction */
  rollback(): Promise<void>;

  /** Gets database client */
  getClient(): SupabaseClient;
}
