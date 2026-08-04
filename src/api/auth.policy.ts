export const API_KEY_HEADER = 'x-api-key';

export const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const SERVICE_ONLY_READ_PATHS = [/^\/tournaments\/\d+\/setup-status\/?$/] as const;

export function shouldRequireApiKey(method: string, path: string): boolean {
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
