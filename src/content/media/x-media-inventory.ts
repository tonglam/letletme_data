import { JSDOM } from 'jsdom';

import {
  fetchPublicResource,
  type PublicDnsLookup,
  type PublicFetch,
} from '../acquisition/http-transport';

const X_PAGE_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const X_IMAGE_HOST = 'pbs.twimg.com';
const X_VIDEO_HOST = 'video.twimg.com';
const X_PAGE_TIMEOUT_MS = 20_000;
const X_PAGE_MAXIMUM_BYTES = 4 * 1_024 * 1_024;

export type XMediaInventoryItem = Readonly<{
  ordinal: number;
  role: 'IMAGE' | 'VIDEO_POSTER' | 'VIDEO_STREAM';
  sourceUrl: string;
  altText: string | null;
  sourceVariant: 'PAGE';
}>;

export type XMediaInventoryResult =
  | Readonly<{ status: 'FOUND'; items: readonly XMediaInventoryItem[] }>
  | Readonly<{ status: 'CHECKED_NONE'; items: readonly [] }>
  | Readonly<{
      status: 'UNAVAILABLE';
      failureClass: 'TARGET_ARTICLE_MISSING' | 'MEDIA_EVIDENCE_UNPARSABLE' | 'X_PAGE_UNAVAILABLE';
      items: readonly [];
    }>;

export type XMediaInventoryOptions = Readonly<{
  timeoutMs?: number;
  maximumBytes?: number;
  fetchImpl?: PublicFetch;
  lookupImpl?: PublicDnsLookup;
  signal?: AbortSignal;
}>;

function statusPathMatches(pathname: string, postId: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  const statusIndex = parts.findIndex((part) => part.toLowerCase() === 'status');
  return statusIndex >= 1 && parts[statusIndex + 1] === postId;
}

function canonicalStatusPathMatches(pathname: string, postId: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  return parts.length === 3 && parts[1]?.toLowerCase() === 'status' && parts[2] === postId;
}

export function assertCanonicalXPostUrl(value: string, postId: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('X media gate URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    !X_PAGE_HOSTS.has(url.hostname.toLowerCase()) ||
    !canonicalStatusPathMatches(url.pathname, postId) ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('X media gate URL must be a canonical HTTPS status URL');
  }
  return url;
}

function exactTargetArticle(document: Document, postId: string, baseUrl: string): Element | null {
  for (const article of document.querySelectorAll('article')) {
    const ownsStatusLink = [...article.querySelectorAll('a[href]')].some((link) => {
      if (link.closest('article') !== article) return false;
      const href = link.getAttribute('href');
      if (!href) return false;
      try {
        const url = new URL(href, baseUrl);
        return (
          X_PAGE_HOSTS.has(url.hostname.toLowerCase()) && statusPathMatches(url.pathname, postId)
        );
      } catch {
        return false;
      }
    });
    if (ownsStatusLink) return article;
  }
  return null;
}

function normalizedXMediaUrl(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.replaceAll('&amp;', '&'));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host === X_IMAGE_HOST) {
    if (url.pathname.startsWith('/media/') || url.pathname.startsWith('/amplify_video_thumb/')) {
      return url.toString();
    }
    return null;
  }
  return host === X_VIDEO_HOST && url.pathname.startsWith('/amplify_video/')
    ? url.toString()
    : null;
}

function videoPosterId(url: string): string | null {
  return new URL(url).pathname.match(/^\/amplify_video_thumb\/(\d+)\//)?.[1] ?? null;
}

function matchingVideoStreamUrls(html: string, posterId: string): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /https:\/\/video\.twimg\.com\/[^"'\\\s<>]+/g;
  for (const raw of html.match(pattern) ?? []) {
    const value = normalizedXMediaUrl(raw);
    if (!value || !value.includes(`/amplify_video/${posterId}/`) || seen.has(value)) continue;
    seen.add(value);
    found.push(value);
  }
  const hls = found.find((value) => new URL(value).pathname.toLowerCase().endsWith('.m3u8'));
  return hls ? [hls] : found.slice(0, 1);
}

export function parseXMediaInventory(input: {
  html: string;
  pageUrl: string;
  postId: string;
}): XMediaInventoryResult {
  const dom = new JSDOM(input.html, { url: input.pageUrl });
  try {
    const article = exactTargetArticle(dom.window.document, input.postId, input.pageUrl);
    if (!article) {
      return { status: 'UNAVAILABLE', failureClass: 'TARGET_ARTICLE_MISSING', items: [] };
    }

    const inventory: Omit<XMediaInventoryItem, 'ordinal'>[] = [];
    const seen = new Set<string>();
    let ambiguousMediaEvidence = false;
    for (const mediaElement of article.querySelectorAll('img[src], video')) {
      if (mediaElement.closest('article') !== article) continue;
      if (mediaElement.closest('[data-testid="card.wrapper"]')) continue;
      const isVideoElement = mediaElement.tagName.toLowerCase() === 'video';
      const sourceUrl = normalizedXMediaUrl(
        mediaElement.getAttribute(isVideoElement ? 'poster' : 'src'),
      );
      if (!sourceUrl) {
        if (isVideoElement || mediaElement.closest('[data-testid="tweetPhoto"]')) {
          ambiguousMediaEvidence = true;
        }
        continue;
      }
      if (seen.has(sourceUrl)) continue;
      seen.add(sourceUrl);
      const posterId = videoPosterId(sourceUrl);
      inventory.push({
        role: posterId || isVideoElement ? 'VIDEO_POSTER' : 'IMAGE',
        sourceUrl,
        altText: mediaElement.getAttribute(isVideoElement ? 'aria-label' : 'alt')?.trim() || null,
        sourceVariant: 'PAGE',
      });
      if (!posterId) continue;
      for (const streamUrl of matchingVideoStreamUrls(input.html, posterId)) {
        if (seen.has(streamUrl)) continue;
        seen.add(streamUrl);
        inventory.push({
          role: 'VIDEO_STREAM',
          sourceUrl: streamUrl,
          altText: null,
          sourceVariant: 'PAGE',
        });
      }
    }

    for (const photoContainer of article.querySelectorAll('[data-testid="tweetPhoto"]')) {
      if (photoContainer.closest('article') !== article) continue;
      if (photoContainer.closest('[data-testid="card.wrapper"]')) continue;
      const hasAcceptedImage = [...photoContainer.querySelectorAll('img[src], video[poster]')].some(
        (element) =>
          normalizedXMediaUrl(
            element.getAttribute(element.tagName.toLowerCase() === 'video' ? 'poster' : 'src'),
          ) !== null,
      );
      if (!hasAcceptedImage) ambiguousMediaEvidence = true;
    }

    if (ambiguousMediaEvidence) {
      return { status: 'UNAVAILABLE', failureClass: 'MEDIA_EVIDENCE_UNPARSABLE', items: [] };
    }
    if (inventory.length === 0) return { status: 'CHECKED_NONE', items: [] };
    return {
      status: 'FOUND',
      items: inventory.map((item, ordinal) => ({ ...item, ordinal })),
    };
  } finally {
    dom.window.close();
  }
}

export async function fetchXMediaInventory(
  canonicalUrl: string,
  postId: string,
  options: XMediaInventoryOptions = {},
): Promise<XMediaInventoryResult> {
  const requestUrl = assertCanonicalXPostUrl(canonicalUrl, postId);
  // twitter.com and www.x.com status URLs are accepted stable identities, but
  // their public pages redirect to x.com. Normalize before the generic HTTP
  // transport so its same-origin redirect gate stays strict.
  requestUrl.hostname = 'x.com';
  try {
    const response = await fetchPublicResource({
      url: requestUrl.toString(),
      timeoutMs: options.timeoutMs ?? X_PAGE_TIMEOUT_MS,
      maximumBytes: options.maximumBytes ?? X_PAGE_MAXIMUM_BYTES,
      acceptedContentTypes: [/^text\/html(?:;|$)/i, /^application\/xhtml\+xml(?:;|$)/i],
      accept: 'text/html, application/xhtml+xml;q=0.9',
      fetchImpl: options.fetchImpl,
      lookupImpl: options.lookupImpl,
      signal: options.signal,
    });
    if (!response.body) {
      return { status: 'UNAVAILABLE', failureClass: 'X_PAGE_UNAVAILABLE', items: [] };
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(response.body);
    return parseXMediaInventory({ html, pageUrl: response.finalUrl, postId });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof Error && error.message.includes('canonical HTTPS status URL')) throw error;
    return { status: 'UNAVAILABLE', failureClass: 'X_PAGE_UNAVAILABLE', items: [] };
  }
}

export function xOriginalImageUrl(sourceUrl: string): string | null {
  const url = new URL(sourceUrl);
  if (url.hostname.toLowerCase() !== X_IMAGE_HOST || !url.pathname.startsWith('/media/')) {
    return null;
  }
  url.searchParams.set('name', 'orig');
  return url.toString();
}
