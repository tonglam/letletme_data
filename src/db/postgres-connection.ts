/**
 * Supabase's port 6543 endpoint is a transaction-mode pooler. Postgres.js
 * prepared statements are session-scoped and therefore cannot be reused
 * safely through that endpoint.
 */
export function isTransactionPoolerConnection(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return url.port === '6543' || url.searchParams.get('pgbouncer') === 'true';
  } catch {
    return false;
  }
}
