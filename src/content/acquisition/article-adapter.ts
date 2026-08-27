import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

import {
  acquisitionBatchV1Schema,
  acquisitionItemV1Schema,
  canonicalizePublicUrl,
  type AcquisitionBatchV1,
  type AcquisitionItemV1,
} from './acquisition-contract';
import { normalizeCanonicalText } from './canonicalization';
import {
  fetchPublicResource,
  publicHttpTrace,
  type AcquisitionHttpTrace,
  type HttpValidator,
  type PublicDnsLookup,
  type PublicFetch,
  type PublicHttpResult,
} from './http-transport';

const ROBOTS_USER_AGENT = 'LetLetMe-Briefing-Acquisition';
const MINIMUM_ARTICLE_CHARACTERS = 500;
const MINIMUM_CONTENT_RATIO = 0.08;

export const ARTICLE_PROFILE_KEY = 'article-readability-v1';
export const ARTICLE_PROFILE_REVISION = 1;

type RobotsRule = Readonly<{
  allow: boolean;
  pattern: string;
}>;

type RobotsGroup = {
  agents: string[];
  rules: RobotsRule[];
};

export type ArticleExtractionMetrics = Readonly<{
  titleLength: number;
  bodyLength: number;
  pageTextLength: number;
  contentRatio: number;
  canonicalUrl: string;
  publishedAt: string | null;
  updatedAt: string | null;
}>;

export type ArticleAdapterResult = Readonly<{
  stateHint: 'CHECKED_NO_CHANGE' | 'COMPLETED';
  batch: AcquisitionBatchV1;
  transports: readonly Readonly<{
    operation: 'robots.fetch' | 'article.fetch';
    transport: PublicHttpResult;
  }>[];
  extraction: ArticleExtractionMetrics | null;
}>;

export class ArticleAdapterError extends Error {
  readonly failureClass: string;
  readonly transports: readonly PublicHttpResult[];

  constructor(failureClass: string, message: string, transports: readonly PublicHttpResult[] = []) {
    super(message);
    this.name = 'ArticleAdapterError';
    this.failureClass = failureClass;
    this.transports = transports;
  }
}

function parseRobotsGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0]?.trim() ?? '';
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }
    if ((field === 'allow' || field === 'disallow') && current?.agents.length) {
      if (field === 'disallow' && value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  return groups;
}

function robotsPatternMatch(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

export function robotsAllows(input: {
  robotsText: string;
  targetUrl: string;
  userAgent?: string;
}): boolean {
  const groups = parseRobotsGroups(input.robotsText);
  const userAgent = (input.userAgent ?? ROBOTS_USER_AGENT).toLowerCase();
  const scored = groups
    .map((group) => ({
      group,
      specificity: Math.max(
        0,
        ...group.agents.map((agent) => {
          if (agent === '*') return 0;
          return userAgent.includes(agent) ? agent.length : -1;
        }),
      ),
      wildcard: group.agents.includes('*'),
    }))
    .filter((entry) => entry.specificity > 0 || entry.wildcard);
  const exactSpecificity = Math.max(0, ...scored.map((entry) => entry.specificity));
  const applicable = scored.filter((entry) =>
    exactSpecificity > 0 ? entry.specificity === exactSpecificity : entry.wildcard,
  );
  const path = `${new URL(input.targetUrl).pathname}${new URL(input.targetUrl).search}`;
  const matching = applicable.flatMap((entry) =>
    entry.group.rules
      .filter((rule) => robotsPatternMatch(rule.pattern, path))
      .map((rule) => ({
        ...rule,
        specificity: rule.pattern.replace(/[\*$]/g, '').length,
      })),
  );
  if (matching.length === 0) return true;
  const longest = Math.max(...matching.map((rule) => rule.specificity));
  return matching.some((rule) => rule.specificity === longest && rule.allow);
}

function decodeUtf8(body: Uint8Array, failureClass: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ArticleAdapterError(failureClass, 'Response is not valid UTF-8');
  }
}

function allowedOriginSet(origins: readonly string[]): Set<string> {
  if (origins.length === 0)
    throw new ArticleAdapterError('ORIGIN_ALLOWLIST_EMPTY', 'No origin allowed');
  const result = new Set<string>();
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
      throw new ArticleAdapterError(
        'ORIGIN_ALLOWLIST_INVALID',
        `Allowed origin must be an exact HTTPS origin: ${origin}`,
      );
    }
    result.add(parsed.origin);
  }
  return result;
}

function assertAllowedOrigin(url: string, allowed: Set<string>, failureClass: string): void {
  if (!allowed.has(new URL(url).origin)) {
    throw new ArticleAdapterError(
      failureClass,
      `URL origin is not allowed: ${new URL(url).origin}`,
    );
  }
}

function selectorContent(document: Document, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const value = node?.getAttribute('content')?.trim() ?? node?.textContent?.trim();
    if (value) return value;
  }
  return null;
}

function isoTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function jsonLdObjects(document: Document): Readonly<Record<string, unknown>>[] {
  const objects: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    objects.push(record);
    const graph = record['@graph'];
    if (Array.isArray(graph)) graph.forEach(visit);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((node) => {
    const text = node.textContent?.trim();
    if (!text) return;
    try {
      visit(JSON.parse(text));
    } catch {
      // Invalid optional metadata cannot replace deterministic HTML extraction.
    }
  });
  return objects;
}

function jsonLdText(
  objects: readonly Readonly<Record<string, unknown>>[],
  key: string,
): string | null {
  for (const object of objects) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function jsonLdAuthor(objects: readonly Readonly<Record<string, unknown>>[]): string | null {
  for (const object of objects) {
    const author = object.author;
    const authors = Array.isArray(author) ? author : [author];
    for (const candidate of authors) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      if (candidate && typeof candidate === 'object') {
        const name = (candidate as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) return name.trim();
      }
    }
  }
  return null;
}

function canonicalFromDocument(document: Document, finalUrl: string): string {
  const href = document.querySelector('link[rel~="canonical"]')?.getAttribute('href')?.trim();
  return canonicalizePublicUrl(href ? new URL(href, finalUrl).toString() : finalUrl);
}

function pageTextLength(document: Document): number {
  const clone = document.body?.cloneNode(true);
  if (!(clone instanceof document.defaultView!.HTMLElement)) return 0;
  clone
    .querySelectorAll('script,style,noscript,template,svg,nav,header,footer,form')
    .forEach((node) => node.remove());
  return normalizeCanonicalText(clone.textContent ?? '').length;
}

function readabilityText(content: string): string {
  const dom = new JSDOM(`<body>${content}</body>`);
  try {
    dom.window.document
      .querySelectorAll('script,style,noscript,template')
      .forEach((node) => node.remove());
    dom.window.document
      .querySelectorAll(
        'address,article,aside,blockquote,br,div,footer,h1,h2,h3,h4,h5,h6,header,li,main,p,section,tr',
      )
      .forEach((node) => node.after(dom.window.document.createTextNode(' ')));
    return normalizeCanonicalText(dom.window.document.body.textContent ?? '');
  } finally {
    dom.window.close();
  }
}

function emptyBatch(input: {
  endpointKey: string;
  checkedAt: Date;
  transport: PublicHttpResult;
}): AcquisitionBatchV1 {
  return acquisitionBatchV1Schema.parse({
    schemaVersion: 1,
    endpointKey: input.endpointKey,
    checkedAt: input.checkedAt.toISOString(),
    validator: {
      ...input.transport.validator,
      providerCursor: null,
      cacheNotBefore: input.transport.cacheNotBefore,
    },
    transportBodyHash: null,
    items: [],
  });
}

export async function runArticleAdapter(input: {
  endpointKey: string;
  discoveryItem: AcquisitionItemV1;
  allowedOrigins: readonly string[];
  validator?: Partial<HttpValidator>;
  now?: Date;
  fetchImpl?: PublicFetch;
  lookupImpl?: PublicDnsLookup;
  timeoutMs?: number;
  maximumBytes?: number;
}): Promise<ArticleAdapterResult> {
  const discoveryItem = acquisitionItemV1Schema.parse(input.discoveryItem);
  if (discoveryItem.endpointKey !== input.endpointKey || discoveryItem.contentKind !== 'ARTICLE') {
    throw new ArticleAdapterError(
      'ARTICLE_DISCOVERY_CONTRACT',
      'Article fetch must retain the discovery endpoint and ARTICLE identity',
    );
  }
  if (!discoveryItem.sourceUrl || discoveryItem.linkAvailability !== 'DIRECT') {
    throw new ArticleAdapterError(
      'ARTICLE_URL_UNAVAILABLE',
      'Article fetch requires a direct discovered source URL',
    );
  }

  const now = input.now ?? new Date();
  const targetUrl = canonicalizePublicUrl(discoveryItem.sourceUrl);
  const allowedOrigins = allowedOriginSet(input.allowedOrigins);
  assertAllowedOrigin(targetUrl, allowedOrigins, 'ARTICLE_ORIGIN_FORBIDDEN');

  const robotsUrl = `${new URL(targetUrl).origin}/robots.txt`;
  const robotsTransport = await fetchPublicResource({
    url: robotsUrl,
    acceptedStatusCodes: [200, 404],
    maximumBytes: 512 * 1_024,
    accept: 'text/plain, */*;q=0.1',
    now,
    fetchImpl: input.fetchImpl,
    lookupImpl: input.lookupImpl,
    timeoutMs: input.timeoutMs,
  });
  if (robotsTransport.status === 200) {
    if (!robotsTransport.body) {
      throw new ArticleAdapterError('ROBOTS_EMPTY', 'robots.txt returned no body', [
        robotsTransport,
      ]);
    }
    const robotsText = decodeUtf8(robotsTransport.body, 'ROBOTS_UTF8_INVALID');
    if (!robotsAllows({ robotsText, targetUrl })) {
      throw new ArticleAdapterError('ROBOTS_DISALLOWED', 'robots.txt disallows this article', [
        robotsTransport,
      ]);
    }
  }

  const articleTransport = await fetchPublicResource({
    url: targetUrl,
    validator: input.validator,
    maximumBytes: input.maximumBytes ?? 8 * 1_024 * 1_024,
    accept: 'text/html, application/xhtml+xml;q=0.9',
    acceptedContentTypes: [/text\/html/i, /application\/xhtml\+xml/i],
    now,
    fetchImpl: input.fetchImpl,
    lookupImpl: input.lookupImpl,
    timeoutMs: input.timeoutMs,
  });
  const transports = [
    { operation: 'robots.fetch' as const, transport: robotsTransport },
    { operation: 'article.fetch' as const, transport: articleTransport },
  ];
  if (articleTransport.status === 304) {
    return {
      stateHint: 'CHECKED_NO_CHANGE',
      batch: emptyBatch({
        endpointKey: input.endpointKey,
        checkedAt: now,
        transport: articleTransport,
      }),
      transports,
      extraction: null,
    };
  }
  if (!articleTransport.body || !articleTransport.bodyHash) {
    throw new ArticleAdapterError('ARTICLE_BODY_EMPTY', 'Article response has no body', [
      robotsTransport,
      articleTransport,
    ]);
  }

  const html = decodeUtf8(articleTransport.body, 'ARTICLE_UTF8_INVALID');
  const dom = new JSDOM(html, { url: articleTransport.finalUrl });
  try {
    const document = dom.window.document;
    const canonicalUrl = canonicalFromDocument(document, articleTransport.finalUrl);
    assertAllowedOrigin(canonicalUrl, allowedOrigins, 'ARTICLE_CANONICAL_ORIGIN_FORBIDDEN');
    const jsonLd = jsonLdObjects(document);
    const publishedAt = isoTimestamp(
      selectorContent(document, [
        'meta[property="article:published_time"]',
        'meta[name="datePublished"]',
        '[itemprop="datePublished"]',
      ]) ?? jsonLdText(jsonLd, 'datePublished'),
    );
    const updatedAt = isoTimestamp(
      selectorContent(document, [
        'meta[property="article:modified_time"]',
        'meta[name="dateModified"]',
        '[itemprop="dateModified"]',
      ]) ?? jsonLdText(jsonLd, 'dateModified'),
    );
    const authorMetadata =
      selectorContent(document, ['meta[name="author"]', '[itemprop="author"]']) ??
      jsonLdAuthor(jsonLd);
    const totalTextLength = pageTextLength(document);
    const article = new Readability(document).parse();
    const title = article?.title ? normalizeCanonicalText(article.title) : '';
    const body = article?.content ? readabilityText(article.content) : '';
    if (!article || !title || !body) {
      throw new ArticleAdapterError('ARTICLE_PARSER_EMPTY', 'Readability returned no article', [
        robotsTransport,
        articleTransport,
      ]);
    }
    if (body.length < MINIMUM_ARTICLE_CHARACTERS) {
      throw new ArticleAdapterError('ARTICLE_BODY_TOO_SHORT', 'Extracted article is too short', [
        robotsTransport,
        articleTransport,
      ]);
    }
    const contentRatio = totalTextLength > 0 ? body.length / totalTextLength : 0;
    if (contentRatio < MINIMUM_CONTENT_RATIO) {
      throw new ArticleAdapterError(
        'ARTICLE_CONTENT_RATIO_LOW',
        'Extracted article-to-page text ratio is too low',
        [robotsTransport, articleTransport],
      );
    }

    const effectivePublishedAt = publishedAt ?? discoveryItem.publishedAt;
    let effectiveUpdatedAt = updatedAt ?? discoveryItem.updatedAt;
    if (
      effectivePublishedAt &&
      effectiveUpdatedAt &&
      Date.parse(effectiveUpdatedAt) < Date.parse(effectivePublishedAt)
    ) {
      effectiveUpdatedAt = null;
    }
    const item = acquisitionItemV1Schema.parse({
      ...discoveryItem,
      canonicalUrl,
      sourceUrl: canonicalUrl,
      linkAvailability: 'DIRECT',
      publishedAt: effectivePublishedAt,
      updatedAt: effectiveUpdatedAt,
      title,
      authorExternalId:
        normalizeCanonicalText(article.byline ?? authorMetadata ?? '') ||
        discoveryItem.authorExternalId,
      body: { availability: 'FULL', text: body },
    });
    const batch = acquisitionBatchV1Schema.parse({
      schemaVersion: 1,
      endpointKey: input.endpointKey,
      checkedAt: now.toISOString(),
      validator: {
        ...articleTransport.validator,
        providerCursor: null,
        cacheNotBefore: articleTransport.cacheNotBefore,
      },
      transportBodyHash: articleTransport.bodyHash,
      items: [item],
    });
    return {
      stateHint: 'COMPLETED',
      batch,
      transports,
      extraction: {
        titleLength: title.length,
        bodyLength: body.length,
        pageTextLength: totalTextLength,
        contentRatio,
        canonicalUrl,
        publishedAt: effectivePublishedAt,
        updatedAt: effectiveUpdatedAt,
      },
    };
  } finally {
    dom.window.close();
  }
}

export function articleHttpTraces(
  result: Pick<ArticleAdapterResult, 'transports'>,
): readonly Readonly<AcquisitionHttpTrace & { operation: string; sequence: number }>[] {
  return result.transports.map((entry, sequence) => ({
    operation: entry.operation,
    sequence,
    ...publicHttpTrace(entry.transport),
  }));
}
