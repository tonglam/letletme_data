# Briefing 多来源采集案例验证 Checklist

> 状态：2026-08-22 的 live feasibility record，不是已上线能力说明。
>
> 当前仓库仍只有 X/Grok acquisition 相关 runner。RSS/Atom、Substack、公开网页、
> Podcast 和 YouTube 尚未接入 scheduler、PostgreSQL、outbox 或生产容器。本轮没有实现
> 代码、migration 或页面，只验证每类来源至少一个真实案例，并锁定实施 gate。

## 1. 范围与结论

本轮纳入六类公开来源：

1. X
2. RSS/Atom
3. Substack
4. 公开网页正文
5. Podcast
6. YouTube

Instagram 和 TikTok 明确不做。六个案例验证的是 adapter 能力，不代表账号/频道覆盖清单
已经足够；20 家俱乐部的跟队来源、Creators/KOL、Publications/Shows 仍需另行扩充。

状态定义：

- `PASS`：当前目标运行位置可以无人值守完成该 gate。
- `BOUNDED_PASS`：真实内容已跑通，但只验证了有界样本，不能推断全量吞吐。
- `PARTIAL`：发现或内容链路的一部分已跑通，仍有明确生产缺口。
- `FAIL`：当前目标运行位置无法通过，不能进入生产。
- `N/A`：该来源不需要此 gate。

| 来源 | 真实案例 | 发现 | 内容 | 增量/缓存 | 转录 | 无人值守 VPS | 总结 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X | `@OfficialFPL` | `PASS` | `PASS` | `PARTIAL` | `N/A` | `FAIL` | shadow 案例可取 10 条；生产 trace/sandbox/version gate 未过 |
| RSS/Atom | Fantasy Football Scout RSS | `PASS` | `PARTIAL` | `PASS` | `N/A` | `PASS` | feed 适合发现；该源只给摘要，正文需触发网页 adapter |
| Substack | SantiSignals | `PASS` | `PASS` | `PASS` | `N/A` | `PASS` | feed 自带 20 条 item 和正文 HTML；不能假定每个付费源都给全文 |
| 公开网页 | AllAboutFPL 文章 | `PASS` | `PASS` | `PASS` | `N/A` | `PASS` | robots 允许，Readability 可稳定提取正文和 metadata |
| Podcast | FML FPL | `PASS` | `PASS` | `PASS` | `BOUNDED_PASS` | `BOUNDED_PASS` | RSS 与音频可在 VPS 获取；Hermes 已转录真实 60 秒样本 |
| YouTube | FPL Focal | `PASS` | `PARTIAL` | `PASS` | `BOUNDED_PASS` | `FAIL` | feed 可取；住宅网络字幕/音频可取，VPS 被 YouTube 拦截 |

不能把 `PARTIAL` 或 `FAIL` 写成“无新内容”。尤其是 X provider gate、YouTube 媒体获取
失败，只能形成失败/延后记录，不能产生空 Receipt 或推进内容 checkpoint。

## 2. 共同采集合同

### 2.1 Entity 与 Endpoint 分离

来源清单不能继续把 Creator 等同于一个 X handle。目标控制面应维护：

- `SourceEntity`：人、俱乐部、机构、节目或出版物的稳定身份，例如 `fpl-focal`。
- `SourceEndpoint`：该实体的一个可采集入口，例如 X handle、YouTube channel ID、Podcast
  feed 或 Substack feed。
- `AcquisitionProfile`：adapter、cadence、预算、正文和转录策略。

一个 Entity 可以有多个 Endpoint；每个 Endpoint 独立保存健康状态、游标和失败状态，但进入
第二层后仍可按 Entity 归因和去重。20 家俱乐部也可以同时挂主跟队、备份跟队和当地媒体，
而不需要伪装成一个来源。

建议的 manifest 形状：

```yaml
entities:
  - entityKey: fpl-focal
    entityType: CREATOR
    enabled: true
    endpoints:
      - endpointKey: fpl-focal-x
        kind: X
        locator:
          handle: FPLFocal
      - endpointKey: fpl-focal-youtube
        kind: YOUTUBE
        locator:
          channelId: UC72QokPHXQ9r98ROfNZmaDw
        contentPolicy: CAPTIONS_THEN_AUDIO
```

Git 只保存稳定身份、入口和策略。以下运行状态必须在 PostgreSQL，而不是回写 manifest：

- resolved URL / stable external ID
- ETag / Last-Modified / provider cursor
- last checked / last changed / last accepted
- failure streak / circuit / next due
- `ACTIVE / DEGRADED / DORMANT / BLOCKED`
- 最近 item 数、相关 Candidate yield 和转录结果

### 2.2 每个 adapter 的固定输出

所有 adapter 先输出 source-native batch/item，再由 Data 生成公共 Receipt。模型不能发明这些
字段：

```ts
type AcquisitionBatchV1 = {
  endpointKey: string;
  checkedAt: string;
  validator: {
    etag: string | null;
    lastModified: string | null;
    providerCursor: string | null;
  };
  transportBodyHash: string | null;
  items: AcquisitionItemV1[];
};

type AcquisitionItemV1 = {
  endpointKey: string;
  externalItemId: string;
  canonicalUrl: string;
  publishedAt: string | null;
  updatedAt: string | null;
  title: string | null;
  authorExternalId: string | null;
  contentKind: 'POST' | 'ARTICLE' | 'EPISODE' | 'VIDEO';
  body: string | null;
  media: Array<{
    url: string;
    mimeType: string | null;
    durationSeconds: number | null;
  }>;
  transcript: {
    status: 'NOT_NEEDED' | 'PROVIDED' | 'GENERATED' | 'FAILED';
    language: string | null;
    segments: Array<{ startMs: number; endMs: number; text: string }>;
  };
  canonicalItemHash: string;
};
```

`canonicalItemHash` 由规范化后的单个 item 事实计算，控制 Receipt revision。
`transportBodyHash` 只是整次 HTTP/provider 响应的诊断证据，不能控制 item revision：同一 feed
可能因 tracking、排序或生成字段变化而出现不同 raw bytes，但实际 item 没有变化。

共同 gates：

- [x] 稳定外部 ID，不用标题或 URL query 当身份。
- [x] canonical URL 只由确定性 adapter 生成。
- [x] 正文、字幕和媒体 hash 在 Data 侧计算。
- [x] 相同 hash 不创建新 revision，不重复转录。
- [x] feed 成功且零条才是空；HTTP/provider/parser 失败不是空。
- [x] 不绕过登录、付费墙或私有内容。
- [x] Briefing 卡片只链接来源，不公开复制全文或完整转录。
- [ ] 这些合同尚未实现为生产 TypeScript schema。

当前 Hermes `transcribe_audio()` helper 只返回拼接后的字符串，不返回 Whisper 原生时间轴。
本轮 probe 因此直接在 Hermes venv 内调用相同 `faster-whisper` model/options 保留 segments。
生产要扩展/封装这一层，不能先丢 timestamps 再让 LLM 猜分段。

segment ID 固定包含 `media hash + STT engine/model revision + startMs + endMs + normalized text`。
相同输入与固定版本重跑应得到相同 segment hash；model/options/chunk scheme 变化则创建新的
transcript revision，不能在原 revision 上改写。

## 3. X 案例：OfficialFPL

### 3.1 请求与结果

- 环境：VPS 宿主机 Grok Build CLI。
- query：`from:OfficialFPL since:2026-08-21 -is:retweet`
- expected tool：`x_keyword_search`
- mode：`Latest`
- limit：`10`
- trace：一个 `tool_call`，随后一个成功 `tool_call_update`，没有第二个 X tool。
- 返回：10 条，均为 `@OfficialFPL`；首个 post ID 为 `2090857970510807271`。
- 结论：达到当前实测返回量 10，必须标记 `SATURATED`，不能据此声称窗口完整。
- 单次报告用量：30,701 tokens，报告成本约 USD 0.01325。

案例 checklist：

- [x] 有真实 tool trace，而不是只相信模型 final answer。
- [x] 能得到 post ID、作者、时间、正文和 URL。
- [x] 同一 query 没有按 Week/News/Views/Features 重复执行。
- [ ] 宿主机版本为 `1.0.3`，未达到 repo 运维合同中的 `1.0.5`。
- [ ] `--sandbox strict` 因 VPS 缺少 `bubblewrap` 而 fail closed。
- [ ] 模型 final answer 在 JSON 外增加了说明和 code fence，未通过严格结构化输出 gate。
- [ ] 当前 SSH 用户无 Docker socket 权限，未验证生产 `content-worker` 镜像内的 CLI、auth
  和 sandbox。

因此该案例只能记为 `shadow transport PASS / production FAIL`。生产修复顺序是先验证容器内
1.0.5、安装并验证 bubblewrap、再重新采集四种 X tool 的 trace fixtures；不能把宿主机
`--sandbox none` 的诊断调用接入 scheduler。

## 4. RSS/Atom 案例：Fantasy Football Scout

### 4.1 请求与结果

- 入口：`https://www.fantasyfootballscout.co.uk/feed/`
- redirect：301 到 `https://www.fantasyfootballscout.co.uk/feed`
- final response：200，`application/rss+xml; charset=UTF-8`
- item 数：12
- 最新 item：`How to enter and play the Last Man Standing 2026/27 competition`
- `pubDate`：`Fri, 21 Aug 2026 16:45:09 +0000`
- GUID：`https://www.fantasyfootballscout.co.uk/?p=174508`
- feed body：description 规范化后 293 chars，SHA-256
  `003dfc1f8c3ee7d2f8cd2edee3cf8c393073b9f8ae2b76dd4143b8fbb549743d`
- validator：ETag 与 Last-Modified 均存在；携带 ETag 重取返回 304。

案例 checklist：

- [x] RSS transport、XML parse、item identity 和时间可用。
- [x] 同一 URL 已在 VPS 取得 200、相同 19,733 bytes 和相同 transport SHA-256。
- [x] conditional GET 可用。
- [x] channel title 为空时仍能依赖 manifest identity，不拒绝整个 feed。
- [x] GUID 和 link 分开保存，redirect 后 canonical feed URL 可缓存。
- [ ] 该 feed 不提供 `content:encoded` 全文，只能作为发现入口。

实现时 `RSS_ATOM` adapter 必须同时支持 RSS 2.0、Atom、namespace 和 CDATA。正文不足时只
发出 article fetch job；不能让 feed parser 自己抓网页，也不能把摘要冒充全文。

## 5. Substack 案例：SantiSignals

### 5.1 请求与结果

- 入口：`https://santisignals.substack.com/feed`
- response：200，`application/xml; charset=utf-8`
- item 数：20
- 最新 item：`The FPL Intelligence Report: The Bomb`
- `pubDate`：`Thu, 20 Aug 2026 06:31:04 GMT`
- GUID/link：`https://santisignals.substack.com/p/the-fpl-intelligence-report-the-bomb`
- feed-supplied body：规范化后 14,984 chars，SHA-256
  `cc7418b0e338deff26b6c57981fdec5f2d024a37151f23222368e7bf189b5ba6`
- validator：weak ETag；携带 ETag 重取返回 304。
- VPS transport 同样返回 200 和 513,601 bytes。Mac/VPS 的 raw XML hash 不同，但最新 item
  规范化正文长度和 SHA-256 完全一致，验证了 item canonical hash 的必要性。

案例 checklist：

- [x] 当前活跃 FPL publication，不使用已经停更的 Fantasy Gameweek 作为验收样本。
- [x] VPS 可直接访问该 feed，不依赖住宅网络或浏览器 session。
- [x] feed 内 title、author、pubDate、GUID、link 和正文 HTML 可解析。
- [x] conditional GET 可用。
- [x] Substack 可以复用 RSS transport 和 parser。
- [ ] 不能仅凭字符数断言“完整文章”；每个 item 必须标记
  `FEED_BODY / EXCERPT_ONLY / METADATA_ONLY`。
- [ ] 付费或登录内容不尝试绕过，只保留公开 metadata/excerpt。

`SUBSTACK` 应是 RSS adapter 的 policy profile，而不是另一套 HTTP client。单独保留 kind 是为
了内容可用性、付费墙和 canonical URL 规则，不是为了多发一次请求。入口规则与 Substack
官方的[publication RSS 说明](https://support.substack.com/hc/en-us/articles/360038239391-Is-there-an-RSS-feed-for-my-publication)
一致。

## 6. 公开网页案例：AllAboutFPL

### 6.1 请求与结果

- URL：
  `https://allaboutfpl.com/2026/08/2026-2027-fpl-team-structure-guide-with-drafts-ratings/`
- robots：`User-agent: *` 下无 Disallow。
- response：200，`text/html; charset=UTF-8`，441,365 bytes。
- canonical URL 与请求 URL 一致。
- metadata：published `2026-08-12T20:48:06+00:00`，modified
  `2026-08-12T20:50:14+00:00`，language `en-US`。
- extractor：`@mozilla/readability@0.6.0` + `jsdom@26.1.0`。
- extracted title：`2026/2027 FPL Team Structure Guide with Drafts & Ratings`
- extracted byline：`allaboutfpl`
- 正文：规范化后 16,858 chars，SHA-256
  `8af16d93ed8642ffae535eef98abcd6bf4e09724ee519eb4bc7fead48f6722bd`
- validator：ETag；携带 ETag 重取返回 304。
- VPS transport 同样返回 200、441,365 bytes 和相同 transport SHA-256。

案例 checklist：

- [x] robots、HTTP status、content type 和最大响应体可在 extraction 前检查。
- [x] canonical、published/modified、title、byline、excerpt 和正文可确定性提取。
- [x] conditional GET 与 content hash 均可防止重复加工。
- [x] 只在 feed/X/semantic discovery 给出具体 URL 后抓正文，不做全站爬虫。
- [ ] 单站点成功不代表所有站点可读；JS-only、Cloudflare、paywall 和 parser-empty 必须是
  显式 failure class。

正文 gate 至少要求：非空 title、canonical 为 HTTP(S)、正文达到最小长度、正文/导航比合理、
响应未超限。Readability 返回空不能回退到整页 `textContent` 后假装成功。

## 7. Podcast 案例：FML FPL

### 7.1 发现与媒体

- Apple podcast ID：`1024068765`
- Apple lookup 解析 feed：`https://feeds.megaphone.fm/COMG5321018029`
- feed response：200，`application/xml; charset=utf-8`
- VPS 同样取得 200、2,082,821 bytes，transport SHA-256 与本机一致。
- episode 数：590
- 最新 episode：`GW1: The Point of No Return`
- GUID：`cda20434-9b82-11f1-959e-2712338872b2`
- `pubDate`：`Wed, 19 Aug 2026 04:18:00 -0000`
- duration：6,178 秒
- enclosure：公开 MP3，可由 VPS ffmpeg 读取。
- `<podcast:transcript>`：0 个。
- validator：Last-Modified；携带该值重取返回 304。

### 7.2 Hermes 转录样本

- 环境：VPS `VM-12-6-ubuntu`，Hermes Agent `0.20.0`。
- STT：Hermes built-in local provider，`faster-whisper`，model `base`。
- 样本：episode 开头 60.084 秒，363,256 bytes。
- audio SHA-256：
  `03c5a5b0f10b2d6dce610dd880d8f2b6d990200a6eb2caa5bf63ce2602b0945e`
- result：success，616 transcript chars。
- transcript SHA-256：
  `310d9c41571f8f3c8d4a1c7cae5a31b316c61afa3ead43ac1cecac0b19dc3ed4`
- 原生时间轴：6 segments，750ms 至 60,000ms；canonical segments SHA-256：
  `6f371ad3484e26809b19fe3ee1e53080f3d861845c6adc6a9fc639f724190653`
- 首次冷启动包含 faster-whisper/model 下载，约 49 秒；这不是每集重复成本。

案例 checklist：

- [x] feed discovery、stable GUID、enclosure 和 duration 可用。
- [x] VPS 能直接获取公开音频。
- [x] 没有 publisher transcript 时，Hermes 本地 STT 可以生成真实转录。
- [x] 同一 Hermes model/options 可保留 timestamped segments，不需要 LLM 切段。
- [x] 文档只记录 hash/长度，不复制公开发布完整 transcript。
- [ ] 只跑了 60 秒样本，没有验证 6,178 秒整集的分块、吞吐、恢复和峰值资源。
- [ ] 生产必须先查 publisher transcript，再决定是否生成；不能每次轮询重复转录。

生产 transcript job 应按 media hash 幂等，固定分块并保留时间码。单块失败只重试该块；所有块
通过后才形成 `GENERATED` transcript revision。转录与第二层语义理解是两个 job，不能让低价
理解模型一边下载媒体一边自由决定是否转录。

Podcast parser 应遵守 Apple 对公开 RSS、稳定 GUID 和 enclosure 的
[feed requirements](https://podcasters.apple.com/support/823-podcast-requirements)，并优先读取
Podcasting 2.0 的 [`<podcast:transcript>`](https://podcasting2.org/docs/podcast-namespace/tags/transcript)。

## 8. YouTube 案例：FPL Focal

### 8.1 发现与字幕

- channel ID：`UC72QokPHXQ9r98ROfNZmaDw`
- feed：
  `https://www.youtube.com/feeds/videos.xml?channel_id=UC72QokPHXQ9r98ROfNZmaDw`
- response：200，`text/xml; charset=UTF-8`，15 个 entry，Cache-Control max-age 900。
- VPS 可直接取该 feed；本机/VPS raw XML hash 不同，但 selected video ID、title 和 published
  完全一致。YouTube feed 中的可变统计字段不能进入 canonical item hash。
- feed 最新条目是 deadline live stream，探测时 duration 为 0；必须先 gate
  `UPCOMING / LIVE / FINISHED`，不能立即转录。
- 选用完成视频 ID：`Xef37ImWz3M`
- title：`FINAL FPL YOUTUBERS Team | DATA FROM 25 TEAMS! 🚀`
- published：`2026-08-21T09:40:37+00:00`
- duration：668 秒，playability `OK`。
- 住宅网络可取得人工 `en-GB` 和自动 `en` 字幕。
- 选用人工字幕：105 segments，0.88 秒至约 665.04 秒，9,704 chars。
- caption text SHA-256：
  `e70708b6fc4839078fc6a45cc33812845bd83209702d6f4cdbc6c91c91cb2b36`

### 8.2 Hermes 音频 fallback 样本

- `yt-dlp@2026.8.19` 在住宅网络读取同一视频前 60 秒。
- audio：60.024 秒，721,389 bytes。
- audio SHA-256：
  `c24149a2fc3c1d5b5e694320b589af7d83b5733b3036202d8b7661e2c40961fb`
- 音频传到 VPS 后由同一 Hermes local/base STT 成功转录。
- result：1,114 transcript chars。
- transcript SHA-256：
  `a5ce1b826243d70ffcdeba7322fb87f9080c791911c2a007c065e22c8dc3dcc9`
- 原生时间轴：14 segments，500ms 至 59,810ms；canonical segments SHA-256：
  `8888a5f3cdba31fa0ed71d060db7ba0d5693b1066e96eee1ee443a3cb552c95b`
- 相同 input/model/options 第二次重跑仍为 14 segments 和同一 segments SHA-256。
- warm transcription wall time：约 17 秒。

### 8.3 未通过的生产 gate

在 VPS 上：

- `youtube-transcript-api` 返回 data-center IP blocked。
- `yt-dlp` 返回 `Sign in to confirm you’re not a bot`。
- 不接受导入个人 cookies；这既需要人工维护，也有账号封禁风险。

因此当前只能记为 `discovery PASS / transcript capability BOUNDED_PASS / VPS media transport
FAIL`。官方 YouTube captions download 也不能作为第三方公开视频的通用替代：下载接口要求
调用者具有编辑该视频的权限，见
[YouTube captions.download](https://developers.google.com/youtube/v3/docs/captions/download)。

上线前必须选择并实测一个无人值守内容入口：

1. 有明确 SLA、价格和使用条款的 transcript/media provider；或
2. 独立、允许 YouTube 获取的 acquisition runner，由它只回传字幕/音频 hash 与受控内容。

未选定前仍可启用 YouTube feed discovery，但新视频只能停在 `CONTENT_DEFERRED`，不能发布
“已检查无内容”。频道通知可后续采用 YouTube 官方
[WebSub push notifications](https://developers.google.com/youtube/v3/guides/push_notifications)，
同时保留 feed poll 作为恢复路径。

## 9. 增量、触发与调用效率

| Adapter | 稳定 item ID | 增量/validator | 触发策略 | LLM/STT 调用 |
| --- | --- | --- | --- | --- |
| X | Snowflake post ID | timestamp overlap + ID dedup；10 条视为饱和 | lane scheduler | 每次 scan 一个 Grok X tool；不按页面拆 query |
| RSS/Atom | GUID，缺失时 canonical link | ETag/Last-Modified + latest item IDs | 按 cache/cadence poll | 无 |
| Substack | GUID/canonical post URL | weak ETag + item IDs | 复用 feed poll | 无 |
| Web article | canonical URL + content hash | ETag/Last-Modified/content hash | 仅由新 link 触发 | 无 |
| Podcast | episode GUID + enclosure hash | feed validator + episode IDs | feed 新 episode 触发 | 仅无 publisher transcript 且 media hash 新时 STT |
| YouTube | channel ID + video ID | feed entry IDs；max-age 900 | WebSub/poll；完成后取内容 | captions 优先；缺失时一次 STT |

效率规则：

- 一次 feed fetch 处理全部返回 item，不按 Week/News/Views/Features 重取。
- article fetch、media fetch、transcript job 都以 stable ID + hash 幂等。
- 只有 source-native 内容实质变化才发 Receipt revision。
- ETag/Last-Modified 304 记为 `CHECKED_NO_CHANGE`，不进入模型。
- transcript 先按 publisher-provided、generated captions、Hermes STT 的顺序复用。
- 第二层理解可以批量消费多个新 Receipt；采集器不调用内容理解模型。

## 10. 无人工运营的列表维护

稳定核心来源与动态发现来源分开：

### 10.1 Core manifest

- 官方、俱乐部、已确认记者和核心 Creator/Publication 以 Git manifest 锁定。
- manifest 变化是版本发布，不是日常运营动作。
- 移除 endpoint 只 pause，不删历史。
- redirect 只有在同 origin 或 stable external ID 一致时自动接受；身份冲突 fail closed。

### 10.2 Runtime health

每个 endpoint 自动执行：

- 连续成功/失败、HTTP/provider failure class、due lag 和 yield 统计。
- 无新 item 是健康 no-change，不累计 provider failure。
- 连续失败退避并进入 `DEGRADED/BLOCKED`；恢复探测成功后自动回到 `ACTIVE`。
- 长期无新内容进入 `DORMANT`，降低到每周探测；出现新 item 自动恢复。
- endpoint 失效不自动删除 Entity，也不让其他 endpoint 停止。

### 10.3 Dynamic discovery pool

为了不依赖人工 24 小时维护，新作者、节目或站点先进入 `OBSERVED`，而不是直接吃正式预算。
自动晋级需要全部满足：

- allowed source kind，公开访问，无登录/付费绕过；
- stable external identity，无现有 Entity/Endpoint 重复；
- 至少三次独立成功抓取；
- 在有界观察窗内持续产生第二层可接受 Candidate，而不是只有 follower/热度信号；
- failure、duplicate 和低相关率低于配置阈值。

通过后进入有调用上限的 `TRIAL`，再按持续 yield 自动成为 `ACTIVE_DYNAMIC`；长期低 yield 自动
回到 `DORMANT`。动态来源不能自动升级成 core，也不能改变官方/俱乐部覆盖预算。所有晋级、
降级和原因必须可查询并可由 manifest 一键禁止。

## 11. 可复现命令与安全边界

以下只用于受控 probe；生产 worker 应使用参数数组、timeout、响应体上限和结构化日志。

```sh
# RSS / Substack / Podcast / YouTube feed
curl -L --fail --max-time 40 -A 'LetLetMeBriefingProbe/0.1 (+https://letletme.com)' \
  -o feed.xml '<feed-url>'
xmllint --xpath 'count(/*[local-name()="rss"]/*[local-name()="channel"]/*[local-name()="item"] | /*[local-name()="feed"]/*[local-name()="entry"])' feed.xml

# Conditional GET；validator 来自上一次成功 response
curl -L --max-time 40 -H 'If-None-Match: <etag>' -o /dev/null -w '%{http_code}' \
  '<feed-or-article-url>'

# YouTube public captions probe（非官方 library；当前 VPS egress 会失败）
uvx --from youtube-transcript-api==1.2.4 youtube_transcript_api \
  --languages en-GB en --format json Xef37ImWz3M

# YouTube audio fallback probe（只取有界片段；当前 VPS egress 会失败）
uvx --from yt-dlp==2026.8.19 yt-dlp --no-playlist \
  --js-runtimes node --download-sections '*0-60' --force-keyframes-at-cuts \
  -x --audio-format mp3 -o '/tmp/youtube-probe.%(ext)s' \
  'https://www.youtube.com/watch?v=Xef37ImWz3M'
```

禁止把以下内容写入 repo、日志或 Receipt：Grok auth、Hermes/provider keys、YouTube cookies、
临时 signed media URL、完整 Grok trace thoughts、完整受版权保护正文或 transcript。

## 12. 实施前剩余 Checklist

### 12.1 Shared

- [ ] 将 manifest 改成 Entity + Endpoint，并完成 Zod schema 与 reconcile。
- [ ] 定义 feed/article/media/transcript 的响应体、时长和并发上限。
- [ ] 定义 Receipt raw-content retention 与访问权限。
- [ ] 为每个 adapter 加 deterministic fixtures、live opt-in probes 和 failure classes。
- [ ] 所有 adapter 统一写 Observation、ReceiptRevision 和 outbox。

### 12.2 X

- [ ] 在实际 production content-worker 中验证 Grok 1.0.5、auth 和四种 X tools。
- [ ] 安装/验证 bubblewrap，严格 sandbox 下重新通过 single-tool trace gate。
- [ ] 修复 final output 结构 gate 并保存脱敏 fixture。

### 12.3 Feed / Web

- [ ] 实现一个 RSS/Atom parser，Substack 和 Podcast 复用 transport。
- [ ] 实现 conditional GET、redirect identity 和 parser-empty gate。
- [ ] 实现 robots-aware article fetch 与 Readability extraction。

### 12.4 Media

- [ ] Podcast 完整长音频分块、恢复、资源和吞吐测试。
- [ ] YouTube 选择可无人值守的内容入口，并在 VPS/目标 runner 重跑同一案例。
- [ ] live/upcoming/finished gate，避免直播开始前生成假 transcript。
- [ ] transcript segment schema、chunk merge、hash reuse 和失败状态。
- [ ] 为 Hermes STT 增加保留原生 timestamps 的稳定 wrapper；不得使用当前只返回字符串的
  helper 作为生产 transcript adapter。

## 13. 本轮验收

- [x] 六类来源均使用真实 FPL 公开内容，不使用合成 fixture 冒充 live case。
- [x] RSS、Substack、公开网页和 Podcast 在目标 VPS 路径具备可实施 transport。
- [x] Podcast 与 YouTube 各有一段真实媒体通过 Hermes local STT。
- [x] YouTube 完整人工字幕可在非数据中心网络获取并形成稳定 segment/hash。
- [x] 所有摘要证据只记录 metadata、长度和 hash，不在 repo 复制原文。
- [x] X 和 YouTube 的生产失败已显式保留，没有写成 `EMPTY` 或 `PASS`。
- [x] Instagram/TikTok 不在范围内。
- [ ] 尚不能宣布多来源第一层 production ready。

本轮环境：macOS acquisition probe、VPS `VM-12-6-ubuntu`、Hermes Agent `0.20.0`、
Grok host CLI `1.0.3`、`@mozilla/readability@0.6.0`、`jsdom@26.1.0`、
`youtube-transcript-api@1.2.4`、`yt-dlp@2026.8.19`。证据采集时间为
`2026-08-21T18:17:41Z` 附近。
