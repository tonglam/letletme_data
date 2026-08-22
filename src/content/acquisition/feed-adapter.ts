import { JSDOM } from 'jsdom';
import { XMLParser } from 'fast-xml-parser';

import {
  acquisitionBatchV1Schema,
  acquisitionItemV1Schema,
  canonicalizePublicUrl,
  type AcquisitionBatchV1,
  type AcquisitionItemV1,
} from './acquisition-contract';
import type { AcquisitionProfile, AdapterKind } from './acquisition-profiles';
import {
  fetchPublicResource,
  publicHttpTrace,
  type HttpValidator,
  type PublicFetch,
  type PublicHttpResult,
} from './http-transport';

type XmlRecord = Record<string, unknown>;

export type FeedItemRejection = Readonly<{
  externalItemId: string;
  reasonCode: string;
}>;

export type FeedAdapterResult = Readonly<{
  stateHint: 'EMPTY' | 'CHECKED_NO_CHANGE' | 'COMPLETED';
  batch: AcquisitionBatchV1;
  rejections: readonly FeedItemRejection[];
  bootstrapMetrics: FeedBootstrapMetrics | null;
  transport: PublicHttpResult;
}>;

export type FeedBootstrapMetrics = Readonly<{
  skippedCount: number;
  missingPublishedAtCount: number;
  outOfScopeCount: number;
  itemLimitCount: number;
  oldestAcceptedAt: string | null;
  newestAcceptedAt: string | null;
}>;

export type BootstrapFeedResult = Readonly<{
  accepted: readonly AcquisitionItemV1[];
  skipped: readonly FeedItemRejection[];
  oldestAcceptedAt: string | null;
  newestAcceptedAt: string | null;
}>;

export function feedHttpTrace(transport: PublicHttpResult): {
  requestMetadataHash: string;
  responseMetadataHash: string;
  transportBodyHash: string | null;
  finalUrlHash: string;
  httpStatus: number;
  redirectCount: number;
  responseBytes: number;
  validatorResult: 'NONE' | 'ETAG' | 'LAST_MODIFIED' | 'BOTH' | 'NOT_MODIFIED';
} {
  return publicHttpTrace(transport);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  allowBooleanAttributes: false,
});

const DEFAULT_FEED_MAXIMUM_BYTES = 8 * 1_024 * 1_024;
const PODCAST_FEED_MAXIMUM_BYTES = 16 * 1_024 * 1_024;

export function effectiveFeedMaximumBytes(input: {
  adapterKind: Extract<AdapterKind, 'RSS_ATOM' | 'PODCAST_FEED' | 'YOUTUBE_CHANNEL'>;
  configuredMaximumBytes?: number;
}): number {
  const configured = input.configuredMaximumBytes ?? DEFAULT_FEED_MAXIMUM_BYTES;
  return input.adapterKind === 'PODCAST_FEED'
    ? Math.max(configured, PODCAST_FEED_MAXIMUM_BYTES)
    : configured;
}

function record(value: unknown): XmlRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlRecord)
    : null;
}

function values(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text || null;
  }
  const node = record(value);
  if (!node) return null;
  return scalarText(node['#text']) ?? scalarText(node['#cdata']);
}

function firstText(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const text = scalarText(candidate);
    if (text) return text;
  }
  return null;
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return canonicalizePublicUrl(value);
  } catch {
    return null;
  }
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function htmlText(value: string | null): string | null {
  if (!value) return null;
  const dom = new JSDOM(`<body>${value}</body>`);
  dom.window.document
    .querySelectorAll('script,style,noscript,template')
    .forEach((node) => node.remove());
  dom.window.document
    .querySelectorAll(
      'address,article,aside,blockquote,br,div,footer,h1,h2,h3,h4,h5,h6,header,li,main,p,section,tr',
    )
    .forEach((node) => node.after(dom.window.document.createTextNode(' ')));
  const text =
    dom.window.document.body.textContent?.replace(/\p{White_Space}+/gu, ' ').trim() ?? '';
  dom.window.close();
  return text || null;
}

function atomLink(node: XmlRecord): string | null {
  for (const candidate of values(node.link)) {
    if (typeof candidate === 'string') return safeUrl(candidate);
    const link = record(candidate);
    if (!link) continue;
    const relation = scalarText(link['@_rel']) ?? 'alternate';
    if (relation === 'alternate') {
      const href = safeUrl(scalarText(link['@_href']));
      if (href) return href;
    }
  }
  return null;
}

function rssLink(node: XmlRecord): string | null {
  for (const candidate of values(node.link)) {
    const link = safeUrl(scalarText(candidate));
    if (link) return link;
  }
  return null;
}

function durationSeconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) {
    return null;
  }
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return (hours ?? 0) * 3_600 + (minutes ?? 0) * 60 + (seconds ?? 0);
}

function rssMedia(node: XmlRecord): AcquisitionItemV1['media'] {
  const duration = durationSeconds(firstText(node['itunes:duration']));
  const media: AcquisitionItemV1['media'] = [];
  for (const candidate of values(node.enclosure)) {
    const enclosure = record(candidate);
    if (!enclosure) continue;
    const url = safeUrl(scalarText(enclosure['@_url']));
    if (!url) continue;
    media.push({
      kind: /^audio\//i.test(scalarText(enclosure['@_type']) ?? '')
        ? 'AUDIO'
        : /^video\//i.test(scalarText(enclosure['@_type']) ?? '')
          ? 'VIDEO'
          : 'OTHER',
      url,
      mimeType: scalarText(enclosure['@_type']),
      durationSeconds: duration,
    });
  }
  for (const candidate of values(node['podcast:transcript'])) {
    const transcript = record(candidate);
    if (!transcript) continue;
    const url = safeUrl(scalarText(transcript['@_url']));
    if (!url) continue;
    media.push({
      kind: 'TRANSCRIPT',
      url,
      mimeType: scalarText(transcript['@_type']),
      durationSeconds: null,
    });
  }
  return media;
}

function bodyFacts(input: {
  fullHtml: string | null;
  excerptHtml: string | null;
  fullAllowed: boolean;
}): AcquisitionItemV1['body'] {
  const full = input.fullAllowed ? htmlText(input.fullHtml) : null;
  if (full) return { availability: 'FULL', text: full };
  const excerpt = htmlText(input.excerptHtml ?? input.fullHtml);
  return excerpt
    ? { availability: 'EXCERPT', text: excerpt }
    : { availability: 'METADATA_ONLY', text: null };
}

function parseRssItem(input: {
  endpointKey: string;
  node: XmlRecord;
  channelLink: string | null;
  adapterKind: AdapterKind;
  profileKey: string;
}): AcquisitionItemV1 {
  const itemLink = rssLink(input.node);
  const guid = firstText(input.node.guid);
  const externalItemId = guid ?? itemLink;
  if (!externalItemId) throw new Error('MISSING_STABLE_ITEM_ID');
  const contentKind = input.adapterKind === 'PODCAST_FEED' ? 'EPISODE' : 'ARTICLE';
  const sourceUrl = itemLink ?? (contentKind === 'EPISODE' ? input.channelLink : null);
  const linkAvailability = itemLink ? 'DIRECT' : sourceUrl ? 'SOURCE_LANDING' : 'MISSING';
  const fullHtml = firstText(input.node['content:encoded']);
  const excerptHtml = firstText(input.node.description, input.node.summary);
  const media = rssMedia(input.node);
  return {
    endpointKey: input.endpointKey,
    externalItemId,
    canonicalUrl: itemLink,
    sourceUrl,
    linkAvailability,
    publishedAt: isoDate(firstText(input.node.pubDate, input.node.published)),
    updatedAt: isoDate(firstText(input.node.updated, input.node['dc:date'])),
    title: firstText(input.node.title),
    authorExternalId: firstText(
      input.node['dc:creator'],
      input.node.author,
      input.node['itunes:author'],
    ),
    contentKind,
    body: bodyFacts({
      fullHtml,
      excerptHtml,
      fullAllowed: input.profileKey === 'substack-public-v1' && Boolean(fullHtml),
    }),
    media,
    transcript: {
      status: contentKind === 'EPISODE' ? 'PENDING' : 'NOT_APPLICABLE',
      language: null,
      trackKind: null,
      providerRevision: null,
      segments: [],
    },
  };
}

function parseAtomItem(input: {
  endpointKey: string;
  node: XmlRecord;
  channelLink: string | null;
  adapterKind: AdapterKind;
}): AcquisitionItemV1 {
  const videoId = firstText(input.node['yt:videoId']);
  const itemLink = atomLink(input.node);
  const externalItemId = videoId ?? firstText(input.node.id) ?? itemLink;
  if (!externalItemId) throw new Error('MISSING_STABLE_ITEM_ID');
  const isVideo = input.adapterKind === 'YOUTUBE_CHANNEL' || Boolean(videoId);
  const contentKind = isVideo ? 'VIDEO' : 'ARTICLE';
  const sourceUrl = itemLink ?? input.channelLink;
  const fullHtml = firstText(input.node.content);
  const excerptHtml = firstText(
    input.node.summary,
    record(input.node['media:group'])?.['media:description'],
  );
  const author = record(input.node.author);
  return {
    endpointKey: input.endpointKey,
    externalItemId,
    canonicalUrl: itemLink,
    sourceUrl,
    linkAvailability: itemLink ? 'DIRECT' : sourceUrl ? 'SOURCE_LANDING' : 'MISSING',
    publishedAt: isoDate(firstText(input.node.published)),
    updatedAt: isoDate(firstText(input.node.updated)),
    title: firstText(input.node.title),
    authorExternalId: firstText(
      input.node['yt:channelId'],
      author?.['yt:channelId'],
      author?.uri,
      author?.name,
    ),
    contentKind,
    body: bodyFacts({ fullHtml, excerptHtml, fullAllowed: Boolean(fullHtml) && !isVideo }),
    media: [],
    transcript: {
      status: isVideo ? 'PENDING' : 'NOT_APPLICABLE',
      language: null,
      trackKind: null,
      providerRevision: null,
      segments: [],
    },
  };
}

export function parseFeedXml(input: {
  endpointKey: string;
  adapterKind: Extract<AdapterKind, 'RSS_ATOM' | 'PODCAST_FEED' | 'YOUTUBE_CHANNEL'>;
  profileKey: string;
  checkedAt: string;
  xml: string;
  transportBodyHash: string;
  validator: HttpValidator & { cacheNotBefore: string | null };
  bootstrap?: Readonly<{
    cutoffAt: Date;
    lookbackMinutes: number;
    maxItems: number;
  }>;
}): {
  batch: AcquisitionBatchV1;
  rejections: readonly FeedItemRejection[];
  bootstrapMetrics: FeedBootstrapMetrics | null;
} {
  if (/<!DOCTYPE|<!ENTITY/i.test(input.xml)) throw new Error('XML_DTD_FORBIDDEN');
  let root: unknown;
  try {
    root = parser.parse(input.xml);
  } catch (error) {
    throw new Error(`XML_PARSE_FAILED: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  const document = record(root);
  if (!document) throw new Error('XML_ROOT_INVALID');
  const rssChannel = record(record(document.rss)?.channel);
  const atomFeed = record(document.feed);
  if (!rssChannel && !atomFeed) throw new Error('UNSUPPORTED_FEED_FORMAT');
  const channel = rssChannel ?? atomFeed!;
  const channelLink = rssChannel ? rssLink(channel) : atomLink(channel);
  const rawNodes = values(rssChannel ? channel.item : channel.entry);
  let bootstrapMetrics: FeedBootstrapMetrics | null = null;
  let nodes = rawNodes;
  if (input.bootstrap) {
    const cutoffMs = input.bootstrap.cutoffAt.getTime();
    const thresholdMs = cutoffMs - input.bootstrap.lookbackMinutes * 60_000;
    const eligible: Array<{ value: unknown; publishedAt: string; publishedMs: number }> = [];
    let missingPublishedAtCount = 0;
    let outOfScopeCount = 0;
    for (const value of rawNodes) {
      const node = record(value);
      const publishedAt = node
        ? isoDate(
            rssChannel
              ? firstText(node.pubDate, node.published)
              : firstText(node.published, node.updated),
          )
        : null;
      if (!publishedAt) {
        missingPublishedAtCount += 1;
        continue;
      }
      const publishedMs = Date.parse(publishedAt);
      if (publishedMs < thresholdMs || publishedMs > cutoffMs) {
        outOfScopeCount += 1;
        continue;
      }
      eligible.push({ value, publishedAt, publishedMs });
    }
    eligible.sort((left, right) => right.publishedMs - left.publishedMs);
    const selected = eligible.slice(0, input.bootstrap.maxItems);
    const itemLimitCount = Math.max(0, eligible.length - selected.length);
    nodes = selected.map((entry) => entry.value);
    bootstrapMetrics = {
      skippedCount: missingPublishedAtCount + outOfScopeCount + itemLimitCount,
      missingPublishedAtCount,
      outOfScopeCount,
      itemLimitCount,
      oldestAcceptedAt: selected.at(-1)?.publishedAt ?? null,
      newestAcceptedAt: selected[0]?.publishedAt ?? null,
    };
  }
  const items: AcquisitionItemV1[] = [];
  const rejections: FeedItemRejection[] = [];
  nodes.forEach((value, index) => {
    const node = record(value);
    if (!node) {
      rejections.push({ externalItemId: `invalid-index-${index}`, reasonCode: 'ITEM_NOT_OBJECT' });
      return;
    }
    const fallbackId =
      firstText(node.guid, node.id, node['yt:videoId']) ?? `invalid-index-${index}`;
    try {
      const item = rssChannel
        ? parseRssItem({
            endpointKey: input.endpointKey,
            node,
            channelLink,
            adapterKind: input.adapterKind,
            profileKey: input.profileKey,
          })
        : parseAtomItem({
            endpointKey: input.endpointKey,
            node,
            channelLink,
            adapterKind: input.adapterKind,
          });
      items.push(acquisitionItemV1Schema.parse(item));
    } catch (error) {
      rejections.push({
        externalItemId: fallbackId,
        reasonCode: error instanceof Error ? error.message.slice(0, 200) : 'ITEM_PARSE_FAILED',
      });
    }
  });
  const parsed = acquisitionBatchV1Schema.safeParse({
    schemaVersion: 1,
    endpointKey: input.endpointKey,
    checkedAt: input.checkedAt,
    validator: {
      etag: input.validator.etag,
      lastModified: input.validator.lastModified,
      providerCursor: null,
      cacheNotBefore: input.validator.cacheNotBefore,
    },
    transportBodyHash: input.transportBodyHash,
    items,
  });
  if (!parsed.success) {
    throw new Error(
      `FEED_SCHEMA_FAILED: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}:${issue.message}`)
        .join('; ')}`,
    );
  }
  return { batch: parsed.data, rejections, bootstrapMetrics };
}

export function applyBootstrapFeedPolicy(input: {
  items: readonly AcquisitionItemV1[];
  profile: AcquisitionProfile;
  cutoffAt: Date;
}): BootstrapFeedResult {
  const threshold = input.cutoffAt.getTime() - input.profile.bootstrap.lookbackMinutes * 60_000;
  const eligible: AcquisitionItemV1[] = [];
  const skipped: FeedItemRejection[] = [];
  for (const item of input.items) {
    if (!item.publishedAt) {
      skipped.push({
        externalItemId: item.externalItemId,
        reasonCode: 'BOOTSTRAP_MISSING_PUBLISHED_AT',
      });
      continue;
    }
    if (
      Date.parse(item.publishedAt) < threshold ||
      Date.parse(item.publishedAt) > input.cutoffAt.getTime()
    ) {
      skipped.push({
        externalItemId: item.externalItemId,
        reasonCode: 'BOOTSTRAP_OUT_OF_SCOPE',
      });
      continue;
    }
    eligible.push(item);
  }
  eligible.sort((left, right) => Date.parse(right.publishedAt!) - Date.parse(left.publishedAt!));
  const accepted = eligible.slice(0, input.profile.bootstrap.maxItems);
  for (const item of eligible.slice(input.profile.bootstrap.maxItems)) {
    skipped.push({ externalItemId: item.externalItemId, reasonCode: 'BOOTSTRAP_ITEM_LIMIT' });
  }
  return {
    accepted,
    skipped,
    oldestAcceptedAt: accepted.at(-1)?.publishedAt ?? null,
    newestAcceptedAt: accepted[0]?.publishedAt ?? null,
  };
}

export function feedUrlForEndpoint(input: {
  adapterKind: Extract<AdapterKind, 'RSS_ATOM' | 'PODCAST_FEED' | 'YOUTUBE_CHANNEL'>;
  locator: Readonly<Record<string, string>>;
}): string {
  if (input.adapterKind === 'YOUTUBE_CHANNEL') {
    const channelId = input.locator.channelId;
    if (!channelId) throw new Error('YouTube endpoint has no channelId');
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  }
  const url = input.locator.url;
  if (!url) throw new Error(`${input.adapterKind} endpoint has no feed URL`);
  return url;
}

export function assertYouTubeFeedIdentity(
  items: readonly AcquisitionItemV1[],
  expectedChannelId: string,
): void {
  const observed = [
    ...new Set(items.map((item) => `${item.contentKind}:${item.authorExternalId ?? 'missing'}`)),
  ].sort();
  if (!expectedChannelId || observed.some((value) => value !== `VIDEO:${expectedChannelId}`)) {
    throw new Error(
      `YOUTUBE_FEED_IDENTITY_MISMATCH expected=${expectedChannelId || 'missing'} observed=${observed.join(',') || 'empty'}`,
    );
  }
}

export async function runFeedAdapter(input: {
  endpointKey: string;
  adapterKind: Extract<AdapterKind, 'RSS_ATOM' | 'PODCAST_FEED' | 'YOUTUBE_CHANNEL'>;
  profileKey: string;
  locator: Readonly<Record<string, string>>;
  validator?: Partial<HttpValidator>;
  bootstrapProfile?: AcquisitionProfile;
  bootstrapCutoffAt?: Date;
  now?: Date;
  fetchImpl?: PublicFetch;
  timeoutMs?: number;
  maximumBytes?: number;
}): Promise<FeedAdapterResult> {
  const now = input.now ?? new Date();
  const transport = await fetchPublicResource({
    url: feedUrlForEndpoint(input),
    validator: input.validator,
    now,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    maximumBytes: effectiveFeedMaximumBytes({
      adapterKind: input.adapterKind,
      configuredMaximumBytes: input.maximumBytes,
    }),
    acceptedContentTypes: [/application\/(?:atom\+xml|rss\+xml|xml)/i, /text\/xml/i],
  });
  if (transport.status === 304) {
    const batch = acquisitionBatchV1Schema.parse({
      schemaVersion: 1,
      endpointKey: input.endpointKey,
      checkedAt: now.toISOString(),
      validator: {
        ...transport.validator,
        providerCursor: null,
        cacheNotBefore: transport.cacheNotBefore,
      },
      transportBodyHash: null,
      items: [],
    });
    return {
      stateHint: 'CHECKED_NO_CHANGE',
      batch,
      rejections: [],
      bootstrapMetrics: null,
      transport,
    };
  }
  if (!transport.body || !transport.bodyHash) throw new Error('HTTP 200 feed has no body');
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(transport.body);
  } catch {
    throw new Error('FEED_UTF8_INVALID');
  }
  const parsed = parseFeedXml({
    endpointKey: input.endpointKey,
    adapterKind: input.adapterKind,
    profileKey: input.profileKey,
    checkedAt: now.toISOString(),
    xml,
    transportBodyHash: transport.bodyHash,
    validator: { ...transport.validator, cacheNotBefore: transport.cacheNotBefore },
    bootstrap:
      input.bootstrapProfile && input.bootstrapCutoffAt
        ? {
            cutoffAt: input.bootstrapCutoffAt,
            lookbackMinutes: input.bootstrapProfile.bootstrap.lookbackMinutes,
            maxItems: input.bootstrapProfile.bootstrap.maxItems,
          }
        : undefined,
  });
  if (input.adapterKind === 'YOUTUBE_CHANNEL') {
    assertYouTubeFeedIdentity(parsed.batch.items, input.locator.channelId ?? '');
  }
  return {
    stateHint:
      parsed.batch.items.length === 0
        ? parsed.bootstrapMetrics && parsed.bootstrapMetrics.skippedCount > 0
          ? 'CHECKED_NO_CHANGE'
          : 'EMPTY'
        : 'COMPLETED',
    ...parsed,
    transport,
  };
}
