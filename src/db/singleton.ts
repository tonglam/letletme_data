import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { logError, logInfo } from '../utils/logger';
import * as schema from './schemas/index.schema';

/**
 * Database Singleton
 * Manages a single database connection throughout the application lifecycle
 */
class DatabaseSingleton {
  private static instance: DatabaseSingleton;
  private client: postgres.Sql | null = null;
  private db: ReturnType<typeof drizzle> | null = null;
  private isConnected = false;
  private isConnecting = false;

  private constructor() {
    // Private constructor prevents direct instantiation
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): DatabaseSingleton {
    if (!DatabaseSingleton.instance) {
      DatabaseSingleton.instance = new DatabaseSingleton();
    }
    return DatabaseSingleton.instance;
  }

  /**
   * Initialize database connection (lazy initialization)
   */
  public async connect(): Promise<void> {
    if (this.isConnected) {
      return; // Already connected
    }

    if (this.isConnecting) {
      // Wait for existing connection attempt
      while (this.isConnecting) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    try {
      this.isConnecting = true;
      logInfo('Initializing database connection...');

      const connectionString =
        process.env.DATABASE_URL || 'postgresql://localhost:5432/letletme_data';

      this.client = postgres(connectionString, {
        max: 10,
        idle_timeout: 20,
        connect_timeout: 10,
      });

      // Test connection
      await this.client`SELECT 1`;

      this.db = drizzle(this.client, { schema });
      this.isConnected = true;

      logInfo('✅ Database connection established');
    } catch (error) {
      logError('❌ Failed to connect to database', error);
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Get the database instance (auto-connects if needed)
   */
  public async getDb(): Promise<ReturnType<typeof drizzle>> {
    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return this.db;
  }

  /**
   * Get the raw client (auto-connects if needed)
   */
  public async getClient(): Promise<postgres.Sql> {
    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    return this.client;
  }

  /**
   * Check if database is connected
   */
  public isHealthy(): boolean {
    return this.isConnected && this.client !== null && this.db !== null;
  }

  /**
   * Test database connection
   */
  public async healthCheck(): Promise<boolean> {
    try {
      if (!this.isConnected || !this.client) {
        return false;
      }

      await this.client`SELECT 1`;
      return true;
    } catch (error) {
      logError('Database health check failed', error);
      return false;
    }
  }

  /**
   * Close database connection
   */
  public async disconnect(): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      logInfo('Closing database connection...');
      await this.client.end();
      this.client = null;
      this.db = null;
      this.isConnected = false;
      logInfo('✅ Database connection closed');
    } catch (error) {
      logError('❌ Error closing database connection', error);
      throw error;
    }
  }

  /**
   * Force reconnection (useful for connection recovery)
   */
  public async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }
}

// Export singleton instance
export const databaseSingleton = DatabaseSingleton.getInstance();

// Convenience exports for backward compatibility
export const getDb = () => databaseSingleton.getDb();
export const getDbClient = () => databaseSingleton.getClient();
