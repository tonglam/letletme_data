import { SupabaseClient } from '@supabase/supabase-js';
import { TransactionContext } from '../../infrastructure/db/types';

export class PostgresTransaction implements TransactionContext {
  private transactionClient: SupabaseClient | null = null;
  isActive: boolean = false;

  constructor(private readonly supabase: SupabaseClient) {}

  async start(): Promise<void> {
    if (this.isActive) {
      throw new Error('Transaction already started');
    }

    try {
      // Note: Supabase doesn't support explicit transactions yet
      // For now, we'll use the main client
      this.transactionClient = this.supabase;
      this.isActive = true;
    } catch (error) {
      console.error('Failed to start transaction:', error);
      throw error;
    }
  }

  getClient(): SupabaseClient {
    if (!this.isActive || !this.transactionClient) {
      throw new Error('No active transaction');
    }
    return this.transactionClient;
  }

  async commit(): Promise<void> {
    if (!this.isActive) {
      throw new Error('No active transaction');
    }

    try {
      // Note: Supabase doesn't support explicit transactions yet
      this.transactionClient = null;
      this.isActive = false;
    } catch (error) {
      console.error('Failed to commit transaction:', error);
      throw error;
    }
  }

  async rollback(): Promise<void> {
    if (!this.isActive) {
      throw new Error('No active transaction');
    }

    try {
      // Note: Supabase doesn't support explicit transactions yet
      this.transactionClient = null;
      this.isActive = false;
    } catch (error) {
      console.error('Failed to rollback transaction:', error);
      throw error;
    }
  }
}
