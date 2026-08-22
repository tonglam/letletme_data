import { JSDOM } from 'jsdom';

import { canonicalizePublicUrl, type AcquisitionItemV1 } from './acquisition-contract';
import { fetchPublicResource, type PublicDnsLookup, type PublicFetch } from './http-transport';
import type { GrokBuildXPostV1 } from './grok-build-executor';

const X_POST_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const X_PAGE_MAXIMUM_BYTES = 2 * 1_024 * 1_024;
const X_PAGE_TIMEOUT_MS = 20_000;

export type XPostMediaStatus = 'FOUND' | 'CHECKED_NONE' | 'UNAVAILABLE';

export type XPostMediaEvidence = Readonly<{
  status: XPostMediaStatus;
  media: ReadonlyArray<AcquisitionItemV1['media'][number]>;
}>;

export type XMediaResolverOptions = Readonly<{
  fetchImpl?: PublicFetch;
  lookupImpl?: PublicDnsLookup;
  timeoutMs?: number;
  maximumBytes?: number;
}>;

export type XMediaResolutionBatch = Readonly<{
  evidenceByPostId: ReadonlyMap<string, XPostMediaEvidence>;
  checkedCount: number;
  foundCount: number;
  unavailableCount: number;
}>;

function asMediaUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'pbs.twimg.com' && hostname !== 'video.twimg.com') return null;
    return canonicalizePublicUrl(url.toString());
  } catch {
    return null;
  }
}

function mediaKind(url: string): 'IMAGE' | 'VIDEO' | null {
  if (url.includes('video.twimg.com/')) return 'VIDEO';
  if (url.includes('pbs.twimg.com/media/') || url.includes('pbs.twimg.com/amplify_video_thumb/')) {
    return 'IMAGE';
  }
  return null;
}

function mimeTypeForMedia(url: string, kind: 'IMAGE' | 'VIDEO'): string | null {
  if (kind === 'VIDEO') {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : 'video/mp4';
  }
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function targetArticle(document: Document, postId: string): Element | null {
  return (
    [...document.querySelectorAll('article')].find((article) =>
      [...article.querySelectorAll('a[href]')].some((link) => {
        try {
          return new URL(link.getAttribute('href') ?? '', 'https://x.com').pathname.includes(
            `/status/${postId}`,
          );
        } catch {
          return false;
        }
      }),
    ) ?? null
  );
}

function extractVideoUrls(html: string, posterUrls: readonly string[]): readonly string[] {
  const candidates = new Set<string>();
  const posterIds = posterUrls
    .map((url) => url.match(/amplify_video_thumb\/(\d+)\//)?.[1])
    .filter((value): value is string => Boolean(value));
  if (posterIds.length === 0) return [];
  const pattern = /https:\/\/video\.twimg\.com\/[^"'\\\s<>]+/g;
  for (const raw of html.match(pattern) ?? []) {
    const url = asMediaUrl(raw.replaceAll('&amp;', '&'));
    if (!url || !url.includes('video.twimg.com/amplify_video/')) continue;
    if (posterIds.some((id) => url.includes(`/amplify_video/${id}/`))) candidates.add(url);
  }
  const sorted = [...candidates].sort();
  return [
    sorted.find((url) => new URL(url).pathname.toLowerCase().endsWith('.m3u8')) ?? sorted[0],
  ].filter((url): url is string => Boolean(url));
}

function mediaFromPage(input: { html: string; finalUrl: string; postId: string }): readonly {
  kind: 'IMAGE' | 'VIDEO';
  url: string;
  mimeType: string | null;
  durationSeconds: null;
}[] {
  const dom = new JSDOM(input.html, { url: input.finalUrl });
  try {
    const article = targetArticle(dom.window.document, input.postId);
    if (!article) return [];
    const imageUrls = [...article.querySelectorAll('img')]
      .map((image) => image.getAttribute('src'))
      .filter((value): value is string => Boolean(value))
      .map(asMediaUrl)
      .filter((value): value is string => Boolean(value))
      .filter((value) => mediaKind(value) === 'IMAGE');
    const videoPosters = imageUrls.filter((value) => value.includes('amplify_video_thumb/'));
    const media = new Map<
      string,
      { kind: 'IMAGE' | 'VIDEO'; url: string; mimeType: string | null }
    >();
    for (const url of imageUrls) {
      const kind = mediaKind(url);
      if (!kind) continue;
      media.set(url, { kind, url, mimeType: mimeTypeForMedia(url, kind) });
    }
    for (const url of extractVideoUrls(input.html, videoPosters)) {
      media.set(url, { kind: 'VIDEO', url, mimeType: mimeTypeForMedia(url, 'VIDEO') });
    }
    return [...media.values()]
      .sort((left, right) => left.url.localeCompare(right.url))
      .map((item) => ({ ...item, durationSeconds: null }));
  } finally {
    dom.window.close();
  }
}

function validatePostUrl(post: GrokBuildXPostV1): void {
  const url = new URL(post.url);
  if (url.protocol !== 'https:' || !X_POST_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('X post URL must be an HTTPS X URL');
  }
  if (!url.pathname.includes(`/status/${post.postId}`)) {
    throw new Error('X post URL does not contain the post ID');
  }
}

export async function resolveXPostMedia(
  post: GrokBuildXPostV1,
  options: XMediaResolverOptions = {},
): Promise<XPostMediaEvidence> {
  try {
    validatePostUrl(post);
    const transport = await fetchPublicResource({
      url: post.url,
      timeoutMs: options.timeoutMs ?? X_PAGE_TIMEOUT_MS,
      maximumBytes: options.maximumBytes ?? X_PAGE_MAXIMUM_BYTES,
      acceptedContentTypes: [/^text\/html(?:;|$)/i, /^application\/xhtml\+xml(?:;|$)/i],
      accept: 'text/html, application/xhtml+xml;q=0.9',
      fetchImpl: options.fetchImpl,
      lookupImpl: options.lookupImpl,
    });
    if (!transport.body) {
      return { status: 'UNAVAILABLE', media: [] };
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(transport.body);
    const media = mediaFromPage({ html, finalUrl: transport.finalUrl, postId: post.postId });
    return { status: media.length > 0 ? 'FOUND' : 'CHECKED_NONE', media };
  } catch {
    return { status: 'UNAVAILABLE', media: [] };
  }
}

export async function resolveXPostMediaBatch(
  posts: readonly GrokBuildXPostV1[],
  options: XMediaResolverOptions & { concurrency?: number } = {},
): Promise<XMediaResolutionBatch> {
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 4)));
  const evidenceByPostId = new Map<string, XPostMediaEvidence>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      const post = posts[index];
      if (!post) return;
      evidenceByPostId.set(post.postId, await resolveXPostMedia(post, options));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, posts.length) }, worker));
  const evidence = [...evidenceByPostId.values()];
  return {
    evidenceByPostId,
    checkedCount: evidence.length,
    foundCount: evidence.filter((item) => item.status === 'FOUND').length,
    unavailableCount: evidence.filter((item) => item.status === 'UNAVAILABLE').length,
  };
}
