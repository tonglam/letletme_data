import { SupabaseClient } from '@supabase/supabase-js';

export interface TransactionContext {
  isActive: boolean;
  start(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  getClient(): SupabaseClient;
}
