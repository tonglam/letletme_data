export type HttpErrorLogLevel = 'debug' | 'warn' | 'error';

export interface HttpRequestLogContext {
  method: string;
  pathname: string;
}

export function getHttpRequestLogContext(request: Request): HttpRequestLogContext | null {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/health' || pathname === '/ready') {
    return null;
  }

  return {
    method: request.method,
    pathname,
  };
}

export function getHttpErrorLogLevel(code: string | number): HttpErrorLogLevel {
  const normalized = String(code);
  if (normalized === 'NOT_FOUND') {
    return 'debug';
  }
  if (normalized === 'VALIDATION') {
    return 'warn';
  }
  return 'error';
}
