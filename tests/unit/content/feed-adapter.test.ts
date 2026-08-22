import { describe, expect, test } from 'bun:test';

import { getAcquisitionProfile } from '../../../src/content/acquisition/acquisition-profiles';
import {
  applyBootstrapFeedPolicy,
  assertYouTubeFeedIdentity,
  parseFeedXml,
  runFeedAdapter,
} from '../../../src/content/acquisition/feed-adapter';

const hash = 'a'.repeat(64);
const validator = { etag: '"v1"', lastModified: null, cacheNotBefore: null };

describe('RSS/Atom feed adapter', () => {
  test('parses Substack content:encoded as explicit feed-supplied full body', () => {
    const result = parseFeedXml({
      endpointKey: 'santi-signals-rss',
      adapterKind: 'RSS_ATOM',
      profileKey: 'substack-public-v1',
      checkedAt: '2026-08-22T00:00:00.000Z',
      transportBodyHash: hash,
      validator,
      xml: `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
          <channel>
            <link>https://santisignals.substack.com/</link>
            <item>
              <guid>post-1</guid>
              <link>https://santisignals.substack.com/p/post-1?utm_source=feed</link>
              <title>  The FPL Report </title>
              <pubDate>Thu, 20 Aug 2026 06:31:04 GMT</pubDate>
              <description><![CDATA[Short <b>excerpt</b>]]></description>
              <content:encoded><![CDATA[<p>Full article body.</p><p>Second paragraph.</p>]]></content:encoded>
            </item>
          </channel>
        </rss>`,
    });

    expect(result.rejections).toHaveLength(0);
    expect(result.batch.items[0]).toMatchObject({
      externalItemId: 'post-1',
      canonicalUrl: 'https://santisignals.substack.com/p/post-1',
      contentKind: 'ARTICLE',
      body: { availability: 'FULL', text: 'Full article body. Second paragraph.' },
      transcript: { status: 'NOT_APPLICABLE' },
    });
  });

  test('accepts a Podcast GUID when item link is absent and uses the source landing', () => {
    const result = parseFeedXml({
      endpointKey: 'fml-fpl-podcast',
      adapterKind: 'PODCAST_FEED',
      profileKey: 'podcast-public-v1',
      checkedAt: '2026-08-22T00:00:00.000Z',
      transportBodyHash: hash,
      validator,
      xml: `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
        <channel>
          <link>https://www.fmlfpl.com/</link>
          <item>
            <guid>cda20434-9b82-11f1-959e-2712338872b2</guid>
            <title>GW1</title>
            <pubDate>Wed, 19 Aug 2026 04:18:00 -0000</pubDate>
            <itunes:duration>01:42:58</itunes:duration>
            <enclosure url="https://cdn.example.com/episode.mp3" type="audio/mpeg" />
          </item>
        </channel>
      </rss>`,
    });
    expect(result.batch.items[0]).toMatchObject({
      canonicalUrl: null,
      sourceUrl: 'https://www.fmlfpl.com/',
      linkAvailability: 'SOURCE_LANDING',
      contentKind: 'EPISODE',
      media: [{ kind: 'AUDIO', durationSeconds: 6_178 }],
      transcript: { status: 'PENDING' },
    });
    expect(() => assertYouTubeFeedIdentity(result.batch.items, 'different-channel')).toThrow(
      'YOUTUBE_FEED_IDENTITY_MISMATCH',
    );
  });

  test('parses YouTube Atom video IDs without treating the channel feed as article HTML', () => {
    const result = parseFeedXml({
      endpointKey: 'fpl-focal-youtube',
      adapterKind: 'YOUTUBE_CHANNEL',
      profileKey: 'youtube-caption-first-v1',
      checkedAt: '2026-08-22T00:00:00.000Z',
      transportBodyHash: hash,
      validator,
      xml: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
        <link rel="alternate" href="https://www.youtube.com/channel/UC72QokPHXQ9r98ROfNZmaDw" />
        <entry>
          <yt:videoId>Xef37ImWz3M</yt:videoId>
          <yt:channelId>UC72QokPHXQ9r98ROfNZmaDw</yt:channelId>
          <author><name>FPL Focal</name><uri>https://www.youtube.com/channel/UC72QokPHXQ9r98ROfNZmaDw</uri></author>
          <title>FPL video</title>
          <link rel="alternate" href="https://www.youtube.com/watch?v=Xef37ImWz3M" />
          <published>2026-08-20T10:00:00+00:00</published>
          <updated>2026-08-20T11:00:00+00:00</updated>
          <media:group><media:description>Video summary</media:description></media:group>
        </entry>
      </feed>`,
    });
    expect(result.batch.items[0]).toMatchObject({
      externalItemId: 'Xef37ImWz3M',
      authorExternalId: 'UC72QokPHXQ9r98ROfNZmaDw',
      contentKind: 'VIDEO',
      body: { availability: 'EXCERPT', text: 'Video summary' },
      transcript: { status: 'PENDING' },
    });
  });

  test('rejects DTD/entity input before parsing', () => {
    expect(() =>
      parseFeedXml({
        endpointKey: 'unsafe-feed',
        adapterKind: 'RSS_ATOM',
        profileKey: 'rss-news-v1',
        checkedAt: '2026-08-22T00:00:00.000Z',
        transportBodyHash: hash,
        validator,
        xml: '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss/>',
      }),
    ).toThrow('XML_DTD_FORBIDDEN');
  });

  test('allows a bounded larger archive for podcast feeds only', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <link>https://example.com/</link>
      <item><guid>episode-1</guid><title>Episode 1</title>
      <pubDate>Fri, 21 Aug 2026 00:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const fetchImpl = async () =>
      new Response(xml, {
        status: 200,
        headers: {
          'content-type': 'application/xml',
          'content-length': String(9 * 1_024 * 1_024),
        },
      });

    await expect(
      runFeedAdapter({
        endpointKey: 'large-podcast',
        adapterKind: 'PODCAST_FEED',
        profileKey: 'podcast-public-v1',
        locator: { url: 'https://1.1.1.1/feed' },
        maximumBytes: 8 * 1_024 * 1_024,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ stateHint: 'COMPLETED' });
    await expect(
      runFeedAdapter({
        endpointKey: 'large-rss',
        adapterKind: 'RSS_ATOM',
        profileKey: 'rss-news-v1',
        locator: { url: 'https://1.1.1.1/feed' },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ failureClass: 'BODY_TOO_LARGE' });
  });

  test('bounds bootstrap by time and item count before triggered content jobs', () => {
    const profile = getAcquisitionProfile('podcast-public-v1');
    expect(profile).toBeDefined();
    if (!profile) return;
    const result = applyBootstrapFeedPolicy({
      profile,
      cutoffAt: new Date('2026-08-22T00:00:00.000Z'),
      items: [
        { ...parseFeedXmlItem('new-1', '2026-08-21T00:00:00.000Z') },
        { ...parseFeedXmlItem('new-2', '2026-08-20T00:00:00.000Z') },
        { ...parseFeedXmlItem('new-3', '2026-08-19T00:00:00.000Z') },
        { ...parseFeedXmlItem('over-limit', '2026-08-18T00:00:00.000Z') },
        { ...parseFeedXmlItem('old', '2020-01-01T00:00:00.000Z') },
        { ...parseFeedXmlItem('missing', null) },
      ],
    });
    expect(result.accepted.map((item) => item.externalItemId)).toEqual(['new-1', 'new-2', 'new-3']);
    expect(result.skipped.map((item) => item.reasonCode).sort()).toEqual([
      'BOOTSTRAP_ITEM_LIMIT',
      'BOOTSTRAP_MISSING_PUBLISHED_AT',
      'BOOTSTRAP_OUT_OF_SCOPE',
    ]);
  });
});

function parseFeedXmlItem(externalItemId: string, publishedAt: string | null) {
  return {
    endpointKey: 'fml-fpl-podcast',
    externalItemId,
    canonicalUrl: null,
    sourceUrl: null,
    linkAvailability: 'MISSING' as const,
    publishedAt,
    updatedAt: null,
    title: externalItemId,
    authorExternalId: null,
    contentKind: 'EPISODE' as const,
    body: { availability: 'METADATA_ONLY' as const, text: null },
    media: [],
    transcript: {
      status: 'PENDING' as const,
      language: null,
      trackKind: null,
      providerRevision: null,
      segments: [],
    },
  };
}
