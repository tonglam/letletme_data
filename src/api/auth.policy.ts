export const API_KEY_HEADER = 'x-api-key';

export const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function shouldRequireApiKey(method: string, _path: string): boolean {
  if (SAFE_HTTP_METHODS.has(method.toUpperCase())) {
    return false;
  }

  return true;
}
