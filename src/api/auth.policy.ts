export const API_KEY_HEADER = 'x-api-key';

export const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function shouldRequireApiKey(method: string, path: string): boolean {
  if (SAFE_HTTP_METHODS.has(method.toUpperCase())) {
    return false;
  }

  if (path.startsWith('/api/auth')) {
    return false;
  }

  return true;
}
