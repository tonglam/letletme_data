/**
 * Database Types Module
 *
 * Defines core types and interfaces for database operations.
 * Provides type definitions for transaction management.
 *
 * Features:
 * - Transaction context types
 * - Client management interfaces
 * - Type-safe operation definitions
 * - Database client abstraction
 *
 * This module ensures type safety and consistent interfaces
 * across the database infrastructure layer.
 */

import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Transaction context interface.
 * Provides transaction lifecycle management and client access.
 *
 * Features:
 * - Transaction state tracking
 * - Atomic operation support
 * - Client access management
 * - Explicit transaction control
 */
export interface TransactionContext {
  /** Indicates if a transaction is currently active */
  isActive: boolean;

  /** Starts a new transaction */
  start(): Promise<void>;

  /** Commits the current transaction */
  commit(): Promise<void>;

  /** Rolls back the current transaction */
  rollback(): Promise<void>;

  /** Gets the database client for transaction operations */
  getClient(): SupabaseClient;
}
