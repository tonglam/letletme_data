import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { canonicalizePublicUrl } from './acquisition-contract';

export type HttpValidator = Readonly<{
  etag: string | null;
  lastModified: string | null;
}>;

type PublicFetchInit = RequestInit & {
  tls?: Readonly<{
    serverName?: string;
    rejectUnauthorized?: boolean;
  }>;
};

export type PublicFetch = (
  input: string | URL | Request,
  init?: PublicFetchInit,
) => Promise<Response>;
export type PublicDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly { address: string; family: number }[]>;

export type PublicHttpResult = Readonly<{
  requestUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: Uint8Array | null;
  bodyHash: string | null;
  responseBytes: number;
  redirects: number;
  validator: HttpValidator;
  cacheNotBefore: string | null;
  requestMetadataHash: string;
  responseMetadataHash: string;
}>;

export type AcquisitionHttpTrace = Readonly<{
  requestMetadataHash: string;
  responseMetadataHash: string;
  transportBodyHash: string | null;
  finalUrlHash: string;
  httpStatus: number;
  redirectCount: number;
  responseBytes: number;
  validatorResult: 'NONE' | 'ETAG' | 'LAST_MODIFIED' | 'BOTH' | 'NOT_MODIFIED';
}>;

export function publicHttpTrace(transport: PublicHttpResult): AcquisitionHttpTrace {
  let validatorResult: AcquisitionHttpTrace['validatorResult'] = 'NONE';
  if (transport.status === 304) validatorResult = 'NOT_MODIFIED';
  else if (transport.validator.etag && transport.validator.lastModified) validatorResult = 'BOTH';
  else if (transport.validator.etag) validatorResult = 'ETAG';
  else if (transport.validator.lastModified) validatorResult = 'LAST_MODIFIED';
  return {
    requestMetadataHash: transport.requestMetadataHash,
    responseMetadataHash: transport.responseMetadataHash,
    transportBodyHash: transport.bodyHash,
    finalUrlHash: createHash('sha256')
      .update(JSON.stringify({ url: transport.finalUrl }), 'utf8')
      .digest('hex'),
    httpStatus: transport.status,
    redirectCount: transport.redirects,
    responseBytes: transport.responseBytes,
    validatorResult,
  };
}

export class PublicHttpError extends Error {
  readonly failureClass: string;

  constructor(failureClass: string, message: string) {
    super(message);
    this.name = 'PublicHttpError';
    this.failureClass = failureClass;
  }
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && octets[2] === 100) return false;
  if (a === 203 && b === 0 && octets[2] === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('2001:db8:')
  ) {
    return false;
  }
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? isPublicIpv4(mapped) : true;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

export async function resolvePublicTarget(
  url: URL,
  allowHttp: boolean,
  lookupImpl: PublicDnsLookup,
): Promise<{ hostname: string; address: string }> {
  if (url.username || url.password) {
    throw new PublicHttpError('URL_CREDENTIALS_FORBIDDEN', 'Public URL cannot contain credentials');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new PublicHttpError('URL_SCHEME_FORBIDDEN', 'Public transport requires HTTPS');
  }
  if (
    (url.protocol === 'https:' && url.port && url.port !== '443') ||
    (url.protocol === 'http:' && url.port && url.port !== '80')
  ) {
    throw new PublicHttpError('URL_PORT_FORBIDDEN', 'Public transport requires the default port');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new PublicHttpError('PRIVATE_TARGET', 'Local network targets are forbidden');
  }
  const literalFamily = isIP(hostname);
  if (literalFamily && !isPublicIpAddress(hostname)) {
    throw new PublicHttpError('PRIVATE_TARGET', 'Private IP targets are forbidden');
  }
  if (literalFamily) return { hostname, address: hostname };
  const addresses = await lookupImpl(hostname, { all: true, verbatim: true }).catch((error) => {
    throw new PublicHttpError(
      'DNS_FAILED',
      `Public hostname resolution failed: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw new PublicHttpError('PRIVATE_TARGET', 'Hostname resolves to a non-public address');
  }
  const address = addresses[0]?.address;
  if (!address) throw new PublicHttpError('DNS_FAILED', 'Public hostname has no address');
  return { hostname, address };
}

function pinnedUrl(url: URL, address: string): string {
  const result = new URL(url.toString());
  result.hostname = address.includes(':') ? `[${address}]` : address;
  return result.toString();
}

function hostHeader(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

function cacheNotBefore(headers: Headers, checkedAt: Date): string | null {
  const cacheControl = headers.get('cache-control') ?? '';
  const maxAge = cacheControl.match(/(?:^|,)\s*(?:s-maxage|max-age)=(\d+)/i)?.[1];
  if (maxAge) return new Date(checkedAt.getTime() + Number(maxAge) * 1_000).toISOString();
  const expires = headers.get('expires');
  if (!expires) return null;
  const expiresAt = Date.parse(expires);
  return Number.isFinite(expiresAt) && expiresAt > checkedAt.getTime()
    ? new Date(expiresAt).toISOString()
    : null;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new PublicHttpError('BODY_TOO_LARGE', 'HTTP Content-Length exceeds the configured limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel('body limit exceeded').catch(() => undefined);
      throw new PublicHttpError('BODY_TOO_LARGE', 'HTTP response exceeded the configured limit');
    }
    chunks.push(chunk.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new PublicHttpError('HTTP_ABORTED', 'Public HTTP request was aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(new PublicHttpError('HTTP_ABORTED', 'Public HTTP request was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function fetchPublicResource(input: {
  url: string;
  validator?: Partial<HttpValidator>;
  timeoutMs?: number;
  maximumBytes?: number;
  maximumRedirects?: number;
  allowHttp?: boolean;
  acceptedContentTypes?: readonly RegExp[];
  acceptedStatusCodes?: readonly number[];
  accept?: string;
  now?: Date;
  fetchImpl?: PublicFetch;
  lookupImpl?: PublicDnsLookup;
  signal?: AbortSignal;
}): Promise<PublicHttpResult> {
  const timeoutMs = input.timeoutMs ?? 40_000;
  const maximumBytes = input.maximumBytes ?? 8 * 1_024 * 1_024;
  const maximumRedirects = input.maximumRedirects ?? 5;
  const fetchImpl = input.fetchImpl ?? fetch;
  const lookupImpl = input.lookupImpl ?? (lookup as PublicDnsLookup);
  const checkedAt = input.now ?? new Date();
  const requestUrl = canonicalizePublicUrl(input.url);
  const accept =
    input.accept ??
    'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, text/html;q=0.5';
  const acceptedStatusCodes = new Set(input.acceptedStatusCodes ?? [200, 304]);
  const requestMetadataHash = createHash('sha256')
    .update(
      JSON.stringify({
        method: 'GET',
        requestUrl,
        accept,
        validator: {
          etag: input.validator?.etag ?? null,
          lastModified: input.validator?.lastModified ?? null,
        },
      }),
      'utf8',
    )
    .digest('hex');
  const allowedOrigin = new URL(requestUrl).origin;
  let currentUrl = requestUrl;

  for (let redirects = 0; redirects <= maximumRedirects; redirects += 1) {
    if (input.signal?.aborted) {
      throw new PublicHttpError('HTTP_ABORTED', 'Public HTTP request was aborted');
    }
    const parsed = new URL(currentUrl);
    const validatedTarget = await abortable(
      resolvePublicTarget(parsed, input.allowHttp ?? false, lookupImpl),
      input.signal,
    );
    if (input.signal?.aborted) {
      throw new PublicHttpError('HTTP_ABORTED', 'Public HTTP request was aborted');
    }
    if (parsed.origin !== allowedOrigin) {
      throw new PublicHttpError('CROSS_ORIGIN_REDIRECT', 'Cross-origin redirect is forbidden');
    }
    const transportUrl =
      validatedTarget.address === validatedTarget.hostname
        ? currentUrl
        : pinnedUrl(parsed, validatedTarget.address);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromCaller = (): void => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (input.signal?.aborted) abortFromCaller();
    const clearRequestGuards = (): void => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abortFromCaller);
    };
    let response: Response;
    try {
      response = await fetchImpl(transportUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: accept,
          'User-Agent': 'LetLetMe-Briefing-Acquisition/1.0',
          ...(validatedTarget.address !== validatedTarget.hostname
            ? { Host: hostHeader(parsed) }
            : {}),
          ...(input.validator?.etag ? { 'If-None-Match': input.validator.etag } : {}),
          ...(input.validator?.lastModified
            ? { 'If-Modified-Since': input.validator.lastModified }
            : {}),
        },
        ...(validatedTarget.address !== validatedTarget.hostname && parsed.protocol === 'https:'
          ? { tls: { serverName: validatedTarget.hostname, rejectUnauthorized: true } }
          : {}),
      });
    } catch (error) {
      clearRequestGuards();
      throw new PublicHttpError(
        controller.signal.aborted ? (timedOut ? 'HTTP_TIMEOUT' : 'HTTP_ABORTED') : 'HTTP_FAILED',
        error instanceof Error ? error.message : 'Public HTTP request failed',
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      clearRequestGuards();
      if (redirects === maximumRedirects) {
        throw new PublicHttpError('TOO_MANY_REDIRECTS', 'HTTP redirect limit exceeded');
      }
      const location = response.headers.get('location');
      if (!location) throw new PublicHttpError('INVALID_REDIRECT', 'Redirect has no Location');
      currentUrl = canonicalizePublicUrl(new URL(location, currentUrl).toString());
      continue;
    }

    const validator = {
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
    const contentType = response.headers.get('content-type');
    if (response.status === 304 && acceptedStatusCodes.has(304)) {
      clearRequestGuards();
      return {
        requestUrl,
        finalUrl: currentUrl,
        status: 304,
        contentType,
        body: null,
        bodyHash: null,
        responseBytes: 0,
        redirects,
        validator,
        cacheNotBefore: cacheNotBefore(response.headers, checkedAt),
        requestMetadataHash,
        responseMetadataHash: createHash('sha256')
          .update(
            JSON.stringify({ status: 304, contentType, validator, finalUrl: currentUrl }),
            'utf8',
          )
          .digest('hex'),
      };
    }
    if (!acceptedStatusCodes.has(response.status)) {
      clearRequestGuards();
      throw new PublicHttpError('HTTP_STATUS', `Unexpected HTTP status ${response.status}`);
    }
    if (
      response.status === 200 &&
      input.acceptedContentTypes?.length &&
      (!contentType || !input.acceptedContentTypes.some((pattern) => pattern.test(contentType)))
    ) {
      clearRequestGuards();
      throw new PublicHttpError(
        'CONTENT_TYPE',
        `Unexpected content type ${contentType ?? 'missing'}`,
      );
    }
    let body: Uint8Array;
    try {
      body = await readBoundedBody(response, maximumBytes);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PublicHttpError(
          timedOut ? 'HTTP_TIMEOUT' : 'HTTP_ABORTED',
          timedOut ? 'HTTP response body timed out' : 'Public HTTP request was aborted',
        );
      }
      throw error;
    } finally {
      clearRequestGuards();
    }
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const metadata = {
      status: response.status,
      contentType,
      validator,
      finalUrl: currentUrl,
      responseBytes: body.byteLength,
      cacheNotBefore: cacheNotBefore(response.headers, checkedAt),
    };
    return {
      requestUrl,
      finalUrl: currentUrl,
      status: response.status,
      contentType,
      body,
      bodyHash,
      responseBytes: body.byteLength,
      redirects,
      validator,
      cacheNotBefore: metadata.cacheNotBefore,
      requestMetadataHash,
      responseMetadataHash: createHash('sha256')
        .update(JSON.stringify(metadata), 'utf8')
        .digest('hex'),
    };
  }
  throw new PublicHttpError('TOO_MANY_REDIRECTS', 'HTTP redirect limit exceeded');
}
