export type HttpErrorLogLevel = 'debug' | 'warn' | 'error';

export interface HttpRequestLogContext {
  method: string;
  pathname: string;
}

export function getHttpRequestLogContext(request: Request): HttpRequestLogContext | null {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/health') {
    return null;
  }

  return {
    method: request.method,
    pathname,
  };
}

export function getHttpErrorLogLevel(code: string): HttpErrorLogLevel {
  if (code === 'NOT_FOUND') {
    return 'debug';
  }
  if (code === 'VALIDATION') {
    return 'warn';
  }
  return 'error';
}
