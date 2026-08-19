export const API_KEY_HEADER = 'x-api-key';

export const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Match the route shape rather than one numeric spelling. Elysia's Numeric
// decoder also accepts values such as `42.0`, which must not bypass auth.
const SERVICE_ONLY_READ_PATHS = [
  /^\/tournaments\/[^/]+\/setup-status\/?$/,
  /^\/understat\/status\/[^/]+\/?$/,
  /^\/understat\/mappings\/[^/]+\/?$/,
  /^\/trends\/public-catalog\/[^/]+\/?$/,
] as const;

function isContentApiPath(path: string): boolean {
  return path === '/content' || path.startsWith('/content/');
}

export function shouldRequireApiKey(method: string, path: string): boolean {
  // Briefing content mutations authenticate with editor/publisher hashes, not
  // DATA_API_KEY_HASHES. The global guard must not 401 those keys first.
  if (isContentApiPath(path)) {
    return false;
  }

  if (
    method.toUpperCase() === 'GET' &&
    SERVICE_ONLY_READ_PATHS.some((pattern) => pattern.test(path))
  ) {
    return true;
  }

  if (SAFE_HTTP_METHODS.has(method.toUpperCase())) {
    return false;
  }

  return true;
}
