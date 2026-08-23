const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Accept only an explicit local PostgreSQL host or a database whose decoded
 * name ends in `_test`. Credentials, query parameters, and arbitrary hostname
 * substrings never participate in the safety decision.
 */
export function isSafeIntegrationDatabaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return false;

    const hostname = url.hostname.toLowerCase();
    if (LOCAL_DATABASE_HOSTS.has(hostname)) return true;

    const databaseName = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    return databaseName.length > 0 && !databaseName.includes('/') && databaseName.endsWith('_test');
  } catch {
    return false;
  }
}

export function areSafeIntegrationRedisDbIndexes(cacheDb: number, queueDb: number): boolean {
  return (
    Number.isInteger(cacheDb) &&
    cacheDb > 0 &&
    Number.isInteger(queueDb) &&
    queueDb > 0 &&
    cacheDb !== queueDb
  );
}
