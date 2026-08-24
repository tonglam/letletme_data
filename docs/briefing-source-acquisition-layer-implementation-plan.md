# Briefing 第一层：多来源采集实施计划

> 状态：目标实施合同与当前 worktree 实施记录；尚未合并、部署或开启 production rollout。
>
> 本文根据
> [Briefing 多来源采集案例验证 Checklist](./briefing-source-acquisition-checklist.md)
> 的 2026-08-22 live probes 修订。当前实施分支已经加入 manifest、schema、queue、adapter、
> ReceiptRevision、pipeline outbox、预算与 health view，但默认开关仍关闭；这些能力不能被描述为
> 已部署或 production ready。真实 Supadata key、目标镜像验证和 VPS rollout 仍是明确 gate；全量
> X identity 与 partition sweep 已在隔离测试数据库完成。

## 1. 目标与边界

第一层负责把公开来源转换成可追溯、可重放的 ReceiptRevision：

```text
版本化 SourceEntity / SourceEndpoint / AcquisitionProfile
  → 到期调度或事件触发
  → X / feed / article / podcast / YouTube adapter
  → 确定性校验与内容获取
  → Receipt + immutable ReceiptRevision + Observation + pipeline outbox
```

最终 Briefing 只有三层：

1. Source Acquisition：本文。
2. Receipt 理解与 Candidate 聚合。
3. Candidate presentation 与 Week/News/Views/Features surface projection。

第一层不做以下工作：

- 不判断内容属于 Week、News、Views 或 Features。
- 不生成 Candidate、标题、摘要、beat、surface eligibility 或 publication state。
- 不创建 Story、slug、正文页或 Edition 内容加工层。
- 不让 LLM 决定事实 ID、canonical URL、时间、来源身份或采集完整性。
- 不抓取 Instagram 或 TikTok。
- 不绕过登录、付费墙、私人内容或 YouTube 账号验证。

允许的公开来源固定为：

- X
- RSS/Atom，包括 Substack public feed
- 公开网页正文
- Podcast public feed、publisher transcript 和公开 enclosure
- YouTube channel feed、公开字幕和受控 ASR

采集是 best-effort 资讯覆盖，不承诺完整归档。失败、跳过、预算不足、provider 饱和和内容延后
必须显式可见，不能伪装成 `EMPTY` 或 `CHECKED_NO_CHANGE`。

## 2. 锁定决策

### 2.1 SourceEntity 与 SourceEndpoint 分离

Creator、记者、俱乐部、节目和出版物是稳定的 `SourceEntity`；X handle、YouTube channel、RSS
feed、Podcast feed 和网站是独立的 `SourceEndpoint`。

例如 `fpl-focal` 是一个 Entity，同时可以拥有 X 和 YouTube Endpoint。下游统一按 Entity 归因，
但每个 Endpoint 独立维护 identity、cadence、checkpoint、validator、预算和健康状态。

### 2.2 同一内容只采集一次

X 账号不会按四个页面或伤病、推迟、观点等业务主题重复扫描。feed 一次响应处理全部 item；新
article、episode 或 video 再触发一次确定性内容 job。跨页面分类由第二层完成。

### 2.3 采集器不使用内容理解模型

- Grok Build 只作为 X transport，通过明确的 X tool contract 取帖子。
- RSS、HTML、Podcast、YouTube 和 provider response 全部由确定性 parser/adapter 处理。
- Hermes/faster-whisper 只做 speech-to-text，不承担内容分类、摘要或来源判断。
- 第二层可以批量调用较低成本模型，但不在本文范围内。

### 2.4 PostgreSQL 是权威状态

Manifest 只描述目标配置。run、lease、checkpoint、provider job ID、ETag、失败、预算、Receipt
和 outbox 都以 PostgreSQL 为准。BullMQ job 只携带 `runId`，不能携带一份会漂移的实时配置。

### 2.5 当前 YouTube 路径

当前 VPS 不能直接用 `youtube-transcript-api` 或 `yt-dlp` 稳定获取 YouTube 字幕/音频。因此：

- YouTube channel feed 可以直接在 VPS 轮询。
- 首版生产字幕入口选择 provider adapter，当前候选为 Supadata `native`。
- Supadata `auto/generate` 必须保持独立开关关闭，直到带 API key 的异步 job 在 VPS 完成验收。
- Hermes 可负责 Podcast ASR；YouTube 只有在另有合规、无人值守的媒体 transport 时才交给
  Hermes，不能假设 Hermes 自己解决 YouTube 下载。

### 2.6 Grok Build 的信任边界

2026-08-22 的 Grok Build 1.0.5 shadow 证明：`streaming-json` 和
`streaming-messages-json` 都能证明只发生了一次指定 X tool call，后者还能暴露实际
`name/query/mode/limit`；但 CLI 的 `tool_result` 只包含调用元数据，不包含返回帖子的原始 payload。
因此“逐条把 final post 绑定到 raw tool result”不是当前 Build CLI 可实现的 gate。

首版明确采用 `GROK_ATTESTED_FINAL` 信任边界：帖子事实来自同一 Grok process 的严格结构化 final，
同时必须通过 single-tool trace、exact request、schema、identity、Snowflake time、window、URL 和
conflict gates。run 保存 `evidence_mode=GROK_ATTESTED_FINAL`，不能对外宣称 raw-result verified。
如果未来业务必须取得 provider 原始帖子 payload，则需要更换为能返回 raw result 的接口，不能在
现有 Grok Build 上伪造这项保证。

媒体不能沿用“没有字段就当作没有图片”的默认值。2026-08-22 的宿主机实测使用
`x_thread_fetch` 获取 `CPFC` 的 `2091144605710647466`：X 主帖页面实际是两张图的轮播，但 Grok
Build final 仍返回 `media: []`，并且视觉证据为不可用。X scan 因此只保存帖子核心事实，并在同一
数据库事务中为 ReceiptRevision 创建 `SourceMediaGate` 和延迟 20 分钟可用的 pipeline outbox。
独立 `media-worker` 随后读取 X 公共页面、下载并校验静态图片、归档到私有 Storage。页面或媒体
失败不再改变 Grok run、ReceiptRevision 或 checkpoint；到期仍未完成时，下游明确得到
`PARTIAL` 媒体覆盖，不能解释为无媒体成功。

Grok Build 1.0.5 的 strict sandbox 依赖 nested bubblewrap namespace；普通非特权 Docker 无法提供，
而为此授予 `--privileged` 不可接受。生产执行边界因此固定为宿主机窄 Runner：content-worker
通过只读 Unix socket 请求 `letletme-grok-runner.service`，Runner 以 `deploy` 用户直接 spawn
宿主机 Grok，并在宿主机使用 `--sandbox strict`。容器只保留非 root/read-only/cap-drop/
no-new-privileges 的 worker 和固定 bridge group；不安装 Grok、不挂载 Grok HOME 或认证文件。
Runner 保留 sanitized child env、版本化 `--disallowed-tools`/deny、`--no-subagents`、启动 tool
inventory gate 和 2 个全局并发上限。strict sandbox、bubblewrap、版本或 Runner release 不匹配时
fail closed，不能退回 `--sandbox none`。

### 2.7 首次启用不是历史归档

首次 poll 只为当前 Briefing 建立有界上下文，不导入 Endpoint 返回的全部历史。profile 必须同时
锁定 bootstrap lookback、最大 metadata item 数和最大 content job 数；旧 item 被确定性记录为
`BOOTSTRAP_OUT_OF_SCOPE`，不创建 Receipt、正文抓取或 transcript job，也不记为 acquisition gap。

## 3. 现状评审

`origin/main` 原有：

- `content-worker` 长进程、30 秒 scheduler tick 和独立 publication outbox dispatcher。
- `content.sources / source_groups / source_group_members`。
- X 专用 `content-x-scan` queue、Grok runner、run/checkpoint/budget 基础表。
- publication foundation 和 Web revalidation loop。

这些能力不能直接作为本文目标实现，原因包括：

- `content.sources` 把一个来源绑定到一个 platform/external ID，不能表达多 Endpoint Entity。
- source/group/member 仍由运行时 editorial API 修改，不是 Git manifest 管理。
- scheduler 只有一个全局 partition，queue input 携带 group、phase 和 window 等可漂移字段。
- X 执行器必须是 `HostGrokRunnerClient`，通过 Unix socket 调用宿主机窄 Runner；不能再由容器内
  generic runner 直接 spawn Grok，也不能绕过四种 Build X tool 的严格 single-call contract。
- BullMQ `attempts=3` 与 PostgreSQL run 状态会形成两套重试状态机。
- run 状态缺少 `CHECKED_NO_CHANGE / SATURATED / GAP / BUDGET_DEFERRED /
  CONTENT_DEFERRED`。
- `source_receipts` 可变且只保存首个 hash，没有 ReceiptRevision、Observation 或 pipeline outbox。
- feed、article、Podcast、YouTube 和 transcript adapter 在基线中均未实现。
- legacy Story/Edition 表仍存在，但不是三层目标设计的下游合同；第一层实施不读取或写入它们。

当前 `codex/briefing-source-acquisition` worktree 已实现但尚未上线：

- 85 个 SourceEntity、108 个 SourceEndpoint 和 44 个 recurring X partitions；Endpoint 分布为
  83 个 X 账号、4 个 X semantic、3 个 RSS/Atom、7 个 Podcast 和 11 个 YouTube。
- 20 家俱乐部均达到 1 个官方来源和 2 个 primary reporting 来源，coverage snapshot 的
  `fullRolloutEligible=true`。
- migration `0025`–`0029`、manifest reconcile、run/lease/budget/outbox、immutable
  ReceiptRevision、Observation、transcript segments 和 acquisition health views。
- Grok Build 1.0.5 single-tool-gated worker，以及 RSS/Atom、article、Podcast/Hermes、YouTube
  metadata 和 Supadata transcript adapter。
- PostgreSQL 15.18 fresh database 上，正式 scheduler/worker 跑完 21 个非 X recurring Endpoint：
  19 个 `COMPLETED`、2 个 `CHECKED_NO_CHANGE`、0 个 `FAILED/EMPTY`，生成 155 个 Receipt、
  155 个 immutable ReceiptRevision、155 个 pipeline outbox event 和 29 个有界 triggered job。
- OfficialFPL 两次有界扫描取得 20 条 Receipt，并在第二次饱和后写 `GAP` 停止；Aston Villa
  双记者 partition 用两次 identity call 加一次合并 keyword call 取得 6 条帖子，验证多账号只扫一次。
- 83/83 X account Endpoint 已通过真实 `x_user_search` 绑定数字 user ID；Aston Villa、Brighton、
  Coventry 的变更 handle 已按 stable Endpoint key 修正，没有静默换绑。
- 全新 PostgreSQL 15 数据库的完整 X sweep 执行 44 个唯一 recurring partition 和 5 个 keyword
  bounded follow-up：49/49 provider trace、0 failure、0 rejected，接收 177 条；状态为 26
  `COMPLETED`、15 `EMPTY`、7 `SATURATED`、1 `GAP`，p50 19,226 ms、p95 47,903 ms，已知成本
  USD 0.49916666。四个 semantic partition 为 2 `COMPLETED`、2 `SATURATED`。
- 11 个真实 YouTube Atom feed 均通过 persisted channel ID identity gate；Podcast 的 16 MiB 专用
  body cap 已覆盖 13,294,897-byte Planet FPL feed，未放宽 RSS/YouTube 的 8 MiB cap。
- recurring retry 会复用失败 run 的 exact request、window、source snapshot 和 endpoint snapshot；
  attempt 3 的 X window 明确落 `GAP`、写 gap record、推进该 X checkpoint 并打开 circuit。

这些结果只证明当前 worktree 和测试基础设施可运行，不代表 VPS service、secret、目标 Docker
镜像、长期吞吐或第二层消费已经启用。

publication outbox/revalidation 必须继续独立运行。任何 manifest、Grok、feed、provider 或 Hermes
故障都不能拖停已有 publication dispatcher。

## 4. 交付基线

- 在执行时从最新 `origin/main` 建立干净的 `codex/briefing-source-acquisition` worktree。
- 纳入本实施计划和 live probe checklist，不混入其他 worktree 的 tournament/live 改动。
- 本次宿主机 Runner 执行边界整改不新增 migration；继续使用 main 已有的 acquisition
  schema、budget、ReceiptRevision、Observation、gap、outbox 和 health view。任何控制面
  schema 变更必须另开 migration 评审，不能借 Runner 发布顺带修改。
- 所有新能力默认关闭；fixture/shadow 不得生成公开 Briefing 内容。
- VPS 上不由代码管理认证；部署阶段由运维以 `deploy` 用户完成一次 attended device auth，
  代码、容器和 workflow 不读取、复制或导出认证。
- Supadata key、Hermes credential 或其他 provider secret 只从运行环境注入，不写入 manifest、
  run snapshot、日志或 fixture。

## 5. 配置与来源控制面

### 5.1 Manifest

新增：

- `config/briefing/sources.yaml`
- `config/briefing/acquisition-plan.yaml`

使用 `yaml` 加 Zod 解析，不依赖本机 Python/PyYAML。

目标结构：

```yaml
entities:
  - sourceKey: fpl-focal
    sourceType: CREATOR
    displayName: FPL Focal
    enabled: true
    origin: MANIFEST
    endpoints:
      - endpointKey: fpl-focal-x
        adapterKind: X_ACCOUNT
        locator:
          handle: FPLFocal
        profileKey: x-creator-v1
      - endpointKey: fpl-focal-youtube
        adapterKind: YOUTUBE_CHANNEL
        locator:
          channelId: UC72QokPHXQ9r98ROfNZmaDw
        profileKey: youtube-caption-first-v1
```

固定 `sourceType`：

`OFFICIAL_FPL / LEAGUE_OFFICIAL / CLUB_OFFICIAL / PLAYER_OFFICIAL / REPORTER / CREATOR /
PUBLICATION / SHOW / AGGREGATOR / DISCOVERED_UNKNOWN`

固定 recurring `adapterKind`：

`X_ACCOUNT / X_SEMANTIC / RSS_ATOM / PODCAST_FEED / YOUTUBE_CHANNEL`

固定 triggered `jobKind`：

`X_IDENTITY / X_KEYWORD_SCAN / X_SEMANTIC_SCAN / X_THREAD_FETCH / FEED_POLL /
ARTICLE_FETCH / PODCAST_TRANSCRIPT / YOUTUBE_METADATA / YOUTUBE_TRANSCRIPT`

Substack 使用 `RSS_ATOM` transport 和 `substack-public-v1` profile；不是另一套 HTTP client。
公开文章 URL 由 feed、X 或 semantic discovery 触发 `ARTICLE_FETCH`，不建立全站爬虫。

`acquisition-plan.yaml` 只允许引用代码中版本化 profile，不允许写任意 Grok query、任意 shell
命令或任意网页 extractor。

profile 还必须显式给出 `bootstrapLookback`、`bootstrapMaxItems` 和
`bootstrapMaxContentJobs`。缺少任一字段时 manifest fail closed，防止首次启用 Podcast 或长寿命
feed 时把全部历史当成新内容。

### 5.2 Core coverage gate

早先的“50 个 X 账号、27 个 X partitions”只能作为初始 X baseline，不能再当作完整来源清单。
当前 snapshot 已扩为 83 个 X 账号和 44 个 X partitions。生产 manifest 至少满足：

- OfficialFPL、Premier League 和当季 20 家俱乐部各有一个官方 Entity/Endpoint。
- 20 家俱乐部各有两个主要跟队记者或当地 publication Entity；如果它同时有 X、RSS 或公开
  文章入口，应挂在同一 Entity 下，而不是算多个来源。
- 核心 FPL reporters 保留 X Endpoint，并按可用情况补 publication/feed Endpoint。
- Creators/KOL 不能只维护 X；已确认的 YouTube channel、Podcast 和 newsletter 必须作为同一
  Entity 的 Endpoint 纳入。
- Publications/Shows 按实际能力配置 X、RSS/Substack、Podcast 和 YouTube Endpoint。
- Instagram/TikTok Endpoint 在 schema 和 manifest validator 中直接拒绝。

CI 编译一份 coverage snapshot，至少输出：

- 每个 source type 的 Entity/Endpoint 数。
- 20 家俱乐部的 official 和 primary reporting coverage 缺口。
- Entity 重复、handle/channel/feed 重复和 orphan Endpoint。
- 各 adapter、lane、cadence 的未来 24 小时调用 forecast。

club coverage 有任何缺口时可合并代码但不能开启 full rollout。

### 5.3 Reconcile

由 service actor 在 worker 启动时 reconcile：

- manifest hash 不变时幂等退出。
- 新 Entity/Endpoint 进入 `PENDING` identity 状态。
- 从 manifest 移除只设为 `PAUSED`，不删除历史。
- `sourceKey / endpointKey` 永久稳定；handle、URL 或显示名变化不换 key。
- 大小写重复 handle、重复 channel ID、重复 feed URL、未知类型、orphan profile、同一 Endpoint
  进入多个 recurring X partition 时，整份 manifest fail closed。
- 配置无效只停止 acquisition scheduler；publication dispatcher 继续运行。
- 保存 manifest hash、Git revision、reconcile 结果和脱敏错误摘要。
- 现有 source/group/member 人工写接口统一返回 `410 SOURCE_REGISTRY_MANIFEST_MANAGED`。

### 5.4 Identity 与动态来源

identity 状态：

`PENDING / VERIFIED / CONFLICT / FAILED`

- X 通过 `x_user_search` 得到 exact case-insensitive handle 和数字 user ID。
- YouTube 以 channel ID 为稳定身份；handle/vanity URL 只作 locator。
- feed 以最终 canonical feed URL 加 manifest Entity 为身份；redirect 必须同 origin 或有稳定
  external ID 证据。
- 已绑定 stable ID 与新结果冲突时禁止静默重绑。
- core identity 每 30 天重验一次；未验证 Endpoint 不执行 recurring scan。

semantic 或内容链接发现的新来源先写成 `DISCOVERED_UNKNOWN + OBSERVED`。自动进入 `TRIAL`
必须满足：公开可访问、stable identity、至少三次独立采集成功、无重复 Entity，并获得第二层
Candidate yield 回传。`TRIAL → ACTIVE_DYNAMIC → DORMANT` 由确定性阈值控制；动态来源不能
自动成为 core，也不能挤占 official/club coverage 预算。

第二层通过 `candidate.source-yield.v1` 只回传 Endpoint、统计窗口、accepted/duplicate/rejected
计数和 reason codes；第一层将它投影到 endpoint health，不读取 Candidate 文本、分类或 surface
状态。没有 yield 回传时动态来源保持 `OBSERVED/TRIAL`，不能仅凭 follower 或抓取成功自动晋级。

## 6. Lane、触发与调用预算

### 6.1 Recurring lanes

| Lane | Adapter | NORMAL / APPROACHING / FINAL90 | 说明 |
| --- | --- | --- | --- |
| Official core | X | 30m / 10m / 3m | OfficialFPL、league official 单账号 |
| Club/reporters | X | 60m / 20m / 10m | 高流量单账号，低流量小分区 |
| Creators/KOL | X | 120m / 60m / 30m | 不按页面或 topic 重复 |
| X semantic | X | 120m / 60m / 30m | 四个版本化主题 profile |
| News/publication feeds | RSS/Atom | 60m / 30m / 15m | 尊重 response cache floor |
| Podcast feeds | RSS/Atom | 60m / 30m / 30m | 新 episode 才触发 transcript |
| YouTube channels | Atom/WebSub | 30m / 15m / 10m | feed poll 为恢复路径 |
| Article/media/transcript | Triggered | event-driven | 无 recurring 全站扫描 |

实际 `nextDueAt` 使用数据库时间：

```text
max(profile cadence due, response cache-not-before, retry backoff, circuit probe time)
```

YouTube FPL Focal feed 实测只有 `Cache-Control: max-age=900`，没有 ETag/Last-Modified。因此
generic feed adapter 必须支持 validator 为空，以 cache floor 加 item ID dedup 工作；不能把
conditional GET 当作每个 feed 的前提。

WebSub 在 polling 稳定后作为优化加入：notification 只创建一次 video observation，仍需 stable
video ID dedup；续订失败不影响 feed recovery poll。

### 6.2 X partitions

X 继续使用“高流量单账号、低流量小分区”的原则，但 partition 由 manifest compiler 生成，
不再在代码和文档各维护一份固定数字。

- 同一 X_ACCOUNT Endpoint 最多属于一个 recurring keyword partition。
- `x_keyword_search` known-source query 只包含 author、时间和 `-is:retweet` 等噪音约束。
- 四个 semantic profile 继续覆盖官方变化、availability、lineup/role、analysis/longform。
- 当前实测单次 keyword 返回 10 条；parser 允许未来超过 10，当前 `10` 是 saturation threshold。
- keyword 返回 10 条只补一个更早窗口；补偿 run 再饱和则记录 gap，不无限翻页。
- semantic tool 只支持日期边界且结果不是可靠的时间分页流。persisted semantic window start 对齐
  `fromDate` 的 UTC 00:00；返回 10 条直接保存并记录 `SEMANTIC_RESULT_CAP`，不追加第二次
  semantic 搜索。

实现补充：每个 X_ACCOUNT partition 仍只有一个 PRIMARY 快线查询，不按页面模块拆分请求；开启
manifest reconciler 始终为 40 个 X_ACCOUNT partition 保留一个 `schedule_role=BACKSTOP`；
`CONTENT_X_BACKSTOP_ENABLED=false` 时这些行是 `paused`，开启后才变为 `active` 并参与 claim。
Backstop 固定在 UTC 00:00/12:00 slot 结束后 10 分钟开始，带 0–10 分钟
确定性 jitter，读取前 12 小时并重叠 120 秒，最多追补 24 小时。它的 request snapshot 明确写
`coverageMode=BACKSTOP`，饱和只产生一个更早窗口 follow-up；PRIMARY 与 BACKSTOP 按 X post ID
共享 Receipt 去重。开关关闭时不 claim backstop，PRIMARY cadence、checkpoint 和历史保持不变。

Grok final output contract 当前为 revision 3：根对象只能是 `posts` 或 `users`，帖文五个事实字段
必须是字符串（媒体-only 帖子的 `text` 可以是字面量空字符串，空白字符串拒绝），
`postId/userId` 不接受数字类型；Data 只去除一个前导 `@`、规范化明确时区到 UTC，
并以 hash 记录被忽略的额外字段。`GROK_FINAL_INVALID`/`GROK_FINAL_SCHEMA_INVALID` 只对同一
immutable request 重试一次；第二次合同失败保持 `FAILED`、不开 GAP、不推进 checkpoint，直到
部署新的 contract revision 后由 rearm 脚本恢复。失败 evidence 只保存 stage、issue path/schema
fingerprint、trace/tool hash、字节数、token/cost 和 runner identity，不保存 final 原文或 thoughts。

### 6.3 多维预算

预算由 PostgreSQL 原子 reserve，不由 worker 内存计数：

- Grok：global rolling-day、lane 和 FINAL90 call ledger。
- HTTP：host concurrency、request bytes 和每日请求 ledger。
- Supadata：native credits、generated credits 和 generated media minutes。
- Hermes：并发、待处理音频分钟和每日转录分钟。

manifest compiler 根据未来 24 小时 cadence forecast 加 20% headroom 生成 CI snapshot。X 初始
并发仍为 2；HTTP 可按 host 设较高并发，但同 host 首版不超过 2；Hermes 首版并发固定为 1。

当前 coverage snapshot 另外记录 backstop 主调用 80 次、最坏 saturation follow-up 80 次和 32 次
headroom；X lane forecast/cap 将这两个 backstop 调用纳入容量计算。它们不是新的页面查询，而是
同一批账号事实的第二个 12 小时覆盖机会。

lane forecast cap 只对 production recurring acquisition 强制执行。`CONTENT_ACQUISITION_SHADOW_MODE=true`
时，shadow、开发验证和受控 backfill 不创建 phase/lane hard-cap reservation；仍然强制 global
rolling-day、FINAL90 provider、runner concurrency、timeout 和 provider quota。这样一次 12 小时
验证不会被此前 recurring scan 消耗的 `NORMAL:CREATOR` 或 `NORMAL:LONGFORM` lane ledger 拦截。
生产 recurring 模式仍保留 lane cap，并且只有 global/provider/capacity 等真正阻断调用的原因才能
产生 `BUDGET_DEFERRED`。

lane cap 不再只能通过 manifest snapshot 固定。运行时支持
`CONTENT_X_LANE_CAP_MULTIPLIER`：它只按整数倍放大已编译的 phase/lane cap，不改变 manifest
forecast、global rolling-day、FINAL90 或 provider ledger。默认值为 `1`；开发、shadow 和首次
生产观察期可以临时提高，等取得真实调用量、饱和率和 due lag 后再调回。该倍率必须由环境配置
显式提供并写入 worker 启动日志，不能在数据库里手工改 ledger（下一次 reconcile 会覆盖）。

X capacity admission：

```text
required call rate <= concurrency × 70% / observed p95 latency
```

容量不足时按以下顺序延后：

```text
Official → Reporter → Club → Semantic → KOL → Longform → Dynamic
```

写 `BUDGET_DEFERRED` 和 due lag，不能声称按 cadence 完成。

Supadata generated 请求在提交前必须已知 video duration，并原子 reserve 预计 credits。官方当前
文档为 native 1 credit、generated 每分钟 2 credits，见
[Supadata transcript guide](https://docs.supadata.ai/get-transcript)；运行时以实际
`x-billable-requests` response header 记账。每个 Endpoint profile 必须配置
`maxGeneratedMinutes`；超时长或预算不足写 `CONTENT_DEFERRED`，不能自动反复提交。

2026-08-22 两次本机 1.0.5 X shadow 的内部计量分别约为 USD 0.0148（10 条）和 USD 0.0177
（2 条格式验证）。返回更少不代表调用更便宜，因此容量和成本优化以减少 Grok process/tool call
次数为主，不为省输出条数拆小 query。完整 sweep 的 49 次调用已知成本 USD 0.49916666，p50
19.2 秒、p95 47.9 秒；该短期样本用于 admission 基线，不代表长期账单上界。

### 6.4 Bootstrap policy

首版 profile 默认值锁定为：

| Profile | Lookback | Max metadata items | Max triggered content jobs |
| --- | ---: | ---: | ---: |
| X account | 6 小时 | 10；keyword 饱和时补一次 | 0 |
| X semantic | 逻辑 6 小时，持久化起点按 UTC 日期对齐 | 10；不分页 | 0 |
| News/publication RSS | 14 天 | 50 | 20 |
| Substack public | 14 天 | 20 | 20 |
| Podcast feed | 14 天 | 3 | 1 |
| YouTube channel | 14 天 | 15 | 5 |

两个边界同时生效：先按 `publishedAt` lookback 过滤，再取按发布时间倒序的前 N 个；时间缺失的
bootstrap item 默认拒绝，不能借此绕过上限。Podcast 只为最新一个合规 episode 创建首次 transcript
job；其余近期 episode 可保留 metadata。正常运行以后只处理相对 checkpoint 新出现或事实 hash
变化的 item，不再套 bootstrap item 数。

## 7. PostgreSQL 目标模型

预计分三组连续手写 migration；执行时按 main 的下一可用编号顺延。

### 7.1 Migration A：Entity、Endpoint 与计划控制面

增量扩展 `content.sources`，将其作为兼容期 SourceEntity：

- `source_key` unique
- `origin=MANIFEST / DISCOVERED`
- `manifest_revision`

复用并扩展现有 `status` 为 `ACTIVE / PAUSED / OBSERVED / DORMANT`。现有
`platform/external_id/handle` 改为 nullable compatibility columns；旧调用可以读取，manifest
reconcile 不再写占位值，新代码也不把它们当作 Entity identity。

不要复用现有 `content.entities` 作为 SourceEntity；该表属于 legacy Story 的 mentioned-entity
模型，identity、权限和生命周期都不同。

新增：

- `content.source_endpoints`
  - `endpoint_id / endpoint_key / source_id`
  - `adapter_kind / profile_key / locator`
  - `stable_external_id`
  - identity status/error/check/next-check
  - `status / origin / rights_policy / manifest_revision`
- `content.source_partitions`
- `content.source_partition_members`
- `content.source_schedules`
- `content.source_registry_reconciliations`

schedule 保存 `next_due_at`、lease、failure streak、circuit、probe time、cache-not-before、validator、
checkpoint 和 under-limit streak。claim 使用 `FOR UPDATE SKIP LOCKED`；claim transaction 内不做
网络、Grok 或转录。

### 7.2 Migration B：通用 run、Observation 与 gap

扩展 `content.acquisition_runs`：

- nullable `endpoint_id / partition_id / parent_run_id`
- `job_kind / adapter_kind / profile_revision`
- immutable request snapshot、request hash、window 和 source/endpoint snapshot
- `attempt_no / lease_expires_at / result_count / rejected_count`
- `provider / provider_job_id / provider_units`
- `failure_class / failure_details_hash`

run 状态：

`PENDING / RUNNING / EMPTY / CHECKED_NO_CHANGE / COMPLETED / PARTIAL / SATURATED / FAILED /
GAP / BUDGET_DEFERRED / CONTENT_DEFERRED`

新增：

- `content.source_observations`
  - `run_id / endpoint_id / receipt_id / receipt_revision_id`
  - `(run_id, receipt_id)` unique
  - item acceptance/rejection、native item hash 和 observed time
- `content.acquisition_gaps`
  - Endpoint/partition、无法覆盖的起止窗口、reason 和 declaring run
- provider-specific trace metadata 表；X trace 与 HTTP/provider metadata 分开，不伪装成同一种
  evidence。

一个 partition/endpoint schedule 同时最多一个 active recurring run。provider job ID 在同一
item/profile revision 上唯一，防止异步 ASR 被重复提交。

### 7.3 Migration C：ReceiptRevision、内容引用与 outbox

保留现有 receipt 兼容列；新下游只读 revision 模型。

- `source_receipts`
  - 新增 global stable `receipt_key` unique。
  - 新增 `source_id / primary_endpoint_id / content_kind`。
  - X 使用 post ID，YouTube 使用 video ID，Podcast 使用 feed identity + GUID，文章使用
    canonical identity 生成 receipt key。
- `source_receipt_revisions`
  - `(receipt_id, revision_number)` unique。
  - immutable；runtime role 无 UPDATE/DELETE 权限并有 trigger 防修改。
  - payload hash 相同不新建 revision；内容恢复到旧 hash 时仍创建更高 revision。
- `source_transcript_revisions`
  - provider/engine/model/options revision、language、track kind、media hash、segments hash、状态。
- `source_transcript_segments`
  - ordinal、start/end ms、normalized text、stable segment hash。
- `pipeline_outbox`
  - `receipt.accepted.v1`
  - `receipt.updated.v1`

outbox payload 只包含 receipt ID、revision ID、run ID、source/endpoint ID 和发生时间，不复制
正文或 transcript。Receipt、revision、transcript reference、Observation、run terminal state、
checkpoint 和 outbox 在同一短事务内提交。

长文章和 transcript 不放入 BullMQ payload。第二层通过 revision ID 从 PostgreSQL 读取受控
内容。当前 legacy Story/Edition 表不在本实施中删除，也不再作为新第一层写入目标。

## 8. 稳定接口与数据合同

### 8.1 Queue input

所有 queue input 固定为：

```ts
type AcquisitionJobV1 = {
  schemaVersion: 1;
  runId: string;
};
```

Worker 根据 `runId` 加载已持久化的 adapter、profile revision、request、source snapshot、window、
预算 reservation 和 parent run。BullMQ `attempts=1`；业务重试由 PostgreSQL 状态机创建新 run，
避免 BullMQ 和数据库各自重试。

Job ID：

```text
content-acq:<jobKind>:<schedule-or-item-key>:<requestHash>:<attemptNo>
```

### 8.2 Adapter output

```ts
type AcquisitionBatchV1 = {
  schemaVersion: 1;
  endpointKey: string;
  checkedAt: string;
  validator: {
    etag: string | null;
    lastModified: string | null;
    providerCursor: string | null;
    cacheNotBefore: string | null;
  };
  transportBodyHash: string | null;
  items: AcquisitionItemV1[];
};

type AcquisitionItemV1 = {
  endpointKey: string;
  externalItemId: string;
  canonicalUrl: string | null;
  sourceUrl: string | null;
  linkAvailability: 'DIRECT' | 'SOURCE_LANDING' | 'MISSING';
  publishedAt: string | null;
  updatedAt: string | null;
  title: string | null;
  authorExternalId: string | null;
  contentKind: 'POST' | 'ARTICLE' | 'EPISODE' | 'VIDEO';
  body: {
    availability: 'FULL' | 'EXCERPT' | 'METADATA_ONLY';
    text: string | null;
  };
  media: Array<{
    kind: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'TRANSCRIPT' | 'OTHER';
    url: string;
    mimeType: string | null;
    durationSeconds: number | null;
  }>;
  transcript: {
    status:
      | 'NOT_APPLICABLE'
      | 'PROVIDED'
      | 'GENERATED'
      | 'PENDING'
      | 'UNAVAILABLE'
      | 'DEFERRED'
      | 'FAILED';
    language: string | null;
    trackKind: 'MANUAL' | 'AUTO' | 'UNKNOWN' | null;
    providerRevision: string | null;
    segments: Array<{
      startMs: number;
      endMs: number;
      text: string;
    }>;
  };
};
```

新 X adapter 固定写 `media: []`，媒体权威状态来自规范化的 `source_media_*` 表。旧
ReceiptRevision 中的 `media` 和 `mediaStatus` 继续可读，但 `xCoreHash` 比较会排除这两个 legacy
字段，避免迁移期间只因媒体模型变化制造新的 immutable revision。

adapter 只返回 source-native facts。Data 生成 captured time、receipt key、canonical payload、内容
hash、segment hash 和内部 ID。

`transportBodyHash` 只用于诊断。单个 item 的 canonical hash 控制 revision；feed 排序、tracking
参数或可变统计字段不能制造假 revision。

`canonicalUrl` 是 source-native item 的稳定 canonical，可以为空；`sourceUrl` 是用户可打开的
来源链接，解析顺序为 item canonical → publisher 提供的 episode/video page → manifest 中稳定的
source landing。临时 signed URL、动态 tracking redirect 和短期 enclosure URL 不能充当 canonical。
两者都缺失时仍可保存 metadata Receipt，但必须是 `linkAvailability=MISSING`，第二、三层不得将其
投影为可发布卡片。Receipt identity 始终来自 adapter-specific stable ID，不从 URL fallback 推导。

### 8.3 Canonicalization V1

Data 统一以 UTF-8、无 BOM 的 recursively key-sorted JSON 计算 SHA-256；object keys 排序，array
保持 source-native 语义顺序。字符串先 NFC；正文将所有 Unicode whitespace 折叠为一个 ASCII
space 并 trim；URL 经 adapter canonicalizer 移除 fragment 和已知 tracking 参数，不能泛化删除
未知 query。

Transcript segment 固定转换为：

```ts
type CanonicalTranscriptSegmentV1 = {
  startMs: number;
  endMs: number;
  text: string;
};
```

- `startMs = Math.round(offsetSeconds * 1000)`。
- `endMs = Math.round((offsetSeconds + durationSeconds) * 1000)`。
- segment text 执行 NFC、全部 Unicode whitespace → 单个 space、trim。
- canonical array 使用 ordinal 顺序，hash 不包含 provider language label。
- segment ID 另外包含 content/media identity、provider/engine/model/options revision 和该 segment
  canonical JSON；provider-native `{text, offset, duration}` hash 只作 transport 对照。

FPL Focal 105-segment probe 按该合同得到 joined text hash
`4bafab0d1150daed41b213ab19ffff581e5cf8056a4c2f18614e224308140c1c`，Canonical Transcript
Segment V1 hash `fb159a11abccf8304b6ff224f180f562450f3d8d84390855e5544dbbf88e6266`。

## 9. 调度与运行流程

### 9.1 Recurring scan

1. worker 启动时解析、校验并 reconcile manifest。
2. 每 30 秒用数据库时间计算 FPL phase 和 due schedules。
3. phase 使用最早未来 deadline：90 分钟内 `FINAL90`，24 小时内 `APPROACHING`，其他
   `NORMAL`。
4. 初次启用按 schedule key 生成 deterministic jitter。
5. claim 数最多为对应 worker concurrency 的两倍。
6. 事务内 claim schedule、写 immutable run/request snapshot、reserve budget 和 lease。
7. 事务外 enqueue；成功后短事务确认。明确 enqueue 失败立即释放 lease，1 分钟后重试。
8. worker 用 run ID 执行一次 adapter operation。
9. X 帖子通过 Grok final 的 deterministic post gates 后，原子写 Observation、ReceiptRevision、
   `SourceMediaGate`、延迟 20 分钟的 outbox、terminal run 和 checkpoint；网络媒体请求不在该事务中。
10. `media-worker` 独立 claim gate 并处理媒体；它不占用 Grok queue，也不能回写 X run 结果。
11. crash 由各自 lease reclaimer 恢复；不同 adapter 使用各自合理 lease。

首次 schedule 还要把 persisted `bootstrap_completed_at` 和 profile revision 写入 request snapshot。
只有 bootstrap terminal run 才能设置完成标记；失败重试复用相同 cutoff 和 item 上限，不能因时间
推移扩大历史范围。被 `BOOTSTRAP_OUT_OF_SCOPE` 排除的数量、最老/最新时间和原因进入 run
metrics，不生成假 Receipt 或 gap。

运行时保留三个隔离的 BullMQ queue，避免长音频占满 X 或普通 HTTP worker：

- `content-x-scan`：Grok Build X jobs，并发 2。
- `content-http-acquisition`：feed、article、YouTube metadata 和 transcript provider jobs，并发 4，
  同 host 并发 2。
- `content-media-transcript`：Podcast/Hermes media jobs，并发 1。

三个 queue 使用同一个 `AcquisitionJobV1` 合同和 PostgreSQL run 状态机，不各自发明 retry、
checkpoint 或 Receipt 写入逻辑。

### 9.2 Triggered content jobs

- RSS/Substack 新 article link → `ARTICLE_FETCH`。
- Podcast 新 episode → 先查 publisher transcript；缺失且 policy 允许 → `PODCAST_TRANSCRIPT`。
- YouTube 新 video → `YOUTUBE_METADATA`；结束且稳定后 → `YOUTUBE_TRANSCRIPT`。
- X receipt 需要线程上下文时由第二层发出有界 `X_THREAD_FETCH` 请求；不建立 recurring thread
  schedule。

parent/child job 全部通过 persisted run 和 stable item identity 关联。重复 feed/WebSub event 只能
复用已有 pending/completed job，不能再次转录。

discovery 可以先形成 metadata-only ReceiptRevision；article body、publisher transcript 或 ASR 到达
后创建更高 revision，绝不 UPDATE 旧 revision。第二层读取 body/transcript status：`PENDING` 时
不调用理解模型，等 terminal content revision 的 outbox 到达后再批处理，避免为同一视频或文章
重复付 LLM 成本。

## 10. Adapter 实施合同

### 10.1 X / Grok Build

宿主机 Runner 锁定 Grok Build 1.0.5，启动用 `grok inspect --json` 验证版本，设置
`GROK_NO_AUTO_UPDATE=1`，并通过 bubblewrap/strict preflight。版本漂移、Runner release 漂移或
strict sandbox 不可用时 fail closed，重新采集 fixtures 后才可升级。

四个 job kind 分别只允许：

- `x_user_search`
- `x_keyword_search`
- `x_semantic_search`
- `x_thread_fetch`

每个 run：一个 job、一个 `grok -p` process、恰好一次预期 X tool call。使用
`streaming-messages-json`，从唯一 `tool_result` 的调用元数据验证实际 tool name、query、mode、
limit 与 persisted request 完全一致；成功 completion 必须发生在 final answer 前。final `result`
必须从第一个字符到最后一个字符都是符合本地 Zod schema 的 JSON，禁止说明、Markdown fence 或
从 prose 中截取 JSON。

当前 CLI 不暴露 X tool 的原始帖子 payload，因此帖子按 2.6 的 `GROK_ATTESTED_FINAL` 合同接收，
不是 raw-result verification。模型 final 无法通过任一确定性 post gate 时整批失败；不能选择性
修补或让另一个模型猜值。

#### X source media archive

Grok final 的 `media` 不能作为媒体存在性的证据：当前 Build 的 `x_keyword_search`、
`x_semantic_search` 和 `x_thread_fetch` 结果可能只给帖文事实，即使 X 页面有图片或视频。每个新的、
非 legacy X ReceiptRevision 都必须拥有唯一 `SourceMediaGate`，由独立 `media-worker` 处理：

- canonical page 只允许 HTTPS `x.com`/`twitter.com` status URL。解析必须找到包含准确 post ID 的目标
  `<article>`；目标 article 缺失是 `UNAVAILABLE/TARGET_ARTICLE_MISSING`，绝不是
  `CHECKED_NONE`。article 中出现无法绑定到允许 CDN URL 的 `tweetPhoto` 或 video 占位时同样必须是
  `UNAVAILABLE/MEDIA_EVIDENCE_UNPARSABLE`，不能把 parser 不认识的媒体伪装成无媒体。
- 只从目标 article 按 DOM 顺序提取 `pbs.twimg.com/media/*`、
  `pbs.twimg.com/amplify_video_thumb/*` 和对应 `video.twimg.com` stream；排除 profile、emoji、回复、
  quote 和外链预览。视频 stream 只进入 inventory，不下载。
- 普通图片优先请求 `name=orig`，失败才回退页面 variant。静态下载只允许 `pbs.twimg.com`，每次 DNS
  和 redirect 都通过 SSRF gate；MIME 按 magic bytes 判断，不相信 URL 或响应 header。
- 仅归档 JPEG、PNG、WebP、GIF；拒绝 SVG 和未知格式。尺寸只由四种允许格式的有界头部解析器读取，
  不调用图片解码器或支持额外格式的通用尺寸库。上限为 24 MiB、8192×8192、67,108,864 pixels。
  对象以 SHA-256 内容地址保存到私有 `briefing-source-media` bucket，不生成
  public URL 或长期 signed URL。部署会把 bucket 限制写成并回读验证 exact 24 MiB；Supabase 不允许
  bucket limit 高于 project global limit，因此 project global 小于 24 MiB 时这一步直接失败。
- Storage 上传策略以 VPS 实测为准，而不是只依据供应商对 TUS 的推荐：2026-08-24 在同一生产
  宿主机和凭据上，24 MiB standard POST 完成私有上传、下载 hash 校验和清理（约 14 秒）；当前
  TUS（创建请求携带首块）以 `ECONNRESET` 失败；TUS 先创建再 PATCH 虽最终成功，但同一 probe
  用时约 10 分钟，超过 media gate 的 4 分钟执行预算。因此生产 `media-worker` 对所有不超过
  24 MiB 的允许图片统一使用 standard POST，`x-upsert=false`；TUS 仅保留为显式 provision
  诊断路径，不能作为生产成功条件。对应实测记录：
  [standard probe](https://github.com/tonglam/letletme_data/actions/runs/32655941861)、
  [TUS no-create probe](https://github.com/tonglam/letletme_data/actions/runs/32655982776)、
  [TUS transport failure](https://github.com/tonglam/letletme_data/actions/runs/32653675966)。
- 同一 gate 的重试只能复用完全一致的 ordinal、role 和 source URL 清单；页面媒体身份在处理中变化时
  记录 `SOURCE_MEDIA_INVENTORY_CHANGED`，不能把旧 asset 静默套到新 DOM 上。
- 清单的 gate、ordinal、role、source URL 与 alt text 在数据库中写后不可变；item 归档/失败更新必须再次
  证明 worker 仍持有对应 RUNNING gate lease，归档引用的 asset 也必须已经是 `AVAILABLE`。
- gate 固定重试 `0m → 1m → 5m → 15m → 1h → 6h → 24h`。20 分钟内达到
  `COMPLETE/CHECKED_NONE` 时提前放行尚未租用的原 Receipt event；20 分钟到期后原 event 自动可用，
  非终态必须向下游解释为 `PARTIAL`。后续状态改善以 `media_state_hash` 幂等发送
  `receipt.media.updated.v1`。
- X scan 与 media worker 没有同步等待关系：媒体失败不改变 X run、不阻止 checkpoint、不重跑
  Grok，也不制造新的 ReceiptRevision。Hermes 图片理解、OCR 和 Candidate 分类不属于第一层。

宿主机 Runner 使用独立临时 cwd、参数数组、`shell=false`、输出上限和 240 秒 timeout。child env 采用
allowlist，不继承 Data/Redis/Supabase/provider secret。启动 event 的工具 inventory 只能包含当前 1.0.5 已知的
四个 residual command-control tool；它们再由 deny 和 `--no-subagents` 阻断。出现新增工具、版本
漂移、第二次调用或 exact request 不匹配都 fail closed。

Data 只通过 `HostGrokRunnerClient` 访问 `/v1/executions`；请求不接受任意 prompt、command、cwd、
path 或 environment。Runner 通过 `/v1/health` 暴露 release、版本、strict sandbox 和最近 X probe，
通过 `/v1/probes/x` 执行真实 `OfficialFPL` probe。应用 image 只携带供部署提取的 glibc standalone
artifact，不在容器内运行它。

部署和 status 流程不能直接 POST probe 绕过 X 调用预算。它们使用
`scripts/run-briefing-control-probe.sh`：先在 PostgreSQL 中创建 control-plane run、锁定
`GLOBAL:GROK_BUILD_X` 的一个 CALL reservation，再调用 Unix socket；成功或 provider 已可能启动时
提交 reservation 并写 provider trace，明确的 pre-provider capacity/rate-limit 则释放并记为
`BUDGET_DEFERRED`。因此 runner 重启后的探针仍计入同一 rolling-day hard cap，且不会和正式 run
的 `provider_units` 统计脱节。

同参数的对抗性实测还分别诱导 `run_terminal_command` 与 `spawn_subagent`；两次均由 permission
policy 拒绝，且 attempt 会留在 streaming trace 中。预算边界也以真实 `grok -p` process launch 为
准：launch 前失败释放 reservation；launch 后 timeout、损坏输出或 trace/schema 失败保守提交一次
调用额度，run 保持 `FAILED + traceVerified=false`，不前移 checkpoint。

旧容器内 Grok sweep 只作为历史诊断，不是当前生产证据。当前实现必须由 CI/部署环境验证
standalone host-runner artifact、VPS systemd Runner、`deploy` 用户 1.0.5、strict sandbox、Unix
socket 连接和四种真实工具 probe；未完成前不能写成 production pass。

### 10.2 RSS/Atom/Substack

一个 HTTP transport 加 profile policy：

- 支持 RSS 2.0、Atom、namespace、CDATA 和 redirect。
- 响应体上限、connect/read timeout、content type、XML entity 安全和 host concurrency gate。
- ETag/Last-Modified 存在时 conditional GET；不存在时使用 cache header 和 item ID dedup。
- 304 为 `CHECKED_NO_CHANGE`。
- 200 且所有 item 已知也是 `CHECKED_NO_CHANGE`，不是 `EMPTY`。
- feed body 只标记 `FULL / EXCERPT / METADATA_ONLY`，不能靠字符数宣称全文。
- Substack 公开 feed 可给全文，但 paywall/login 内容只保存 metadata/excerpt。

### 10.3 公开网页

只接受已发现的具体 URL：

- 检查 robots、redirect、status、content type 和 body size。
- 使用锁定版本的 `@mozilla/readability` + `jsdom` 提取 title、byline、canonical、published、
  modified 和正文。
- canonical host 必须符合 Endpoint allowlist；跨 origin redirect fail closed。
- parser-empty、JS-only、Cloudflare、paywall 分别记录 failure class。
- Readability 为空不能回退到整页 `textContent` 后声称成功。

### 10.4 Podcast

- Podcast feed 复用 RSS transport，episode identity 优先 GUID。
- item-level link 可以缺失。此时保存 GUID、feed Endpoint 和 media facts，并按 8.2 解析稳定
  source landing；不能把包含 session/timetoken 的 enclosure redirect 当 canonical URL。
- 优先读取 Podcasting 2.0 `<podcast:transcript>`。
- 没有 publisher transcript 时，公开 enclosure 可交给 Hermes transcript adapter。
- transcript job 按 enclosure/media hash 幂等，固定分块；单块失败只重试该块。
- Hermes adapter 必须返回原生 timestamped segments。当前只返回拼接字符串的 helper 不可用于
  生产。
- 首版 Hermes concurrency 为 1；完整长节目吞吐和资源 gate 通过前只允许有界 duration。

Hermes 集成必须是固定、认证、结构化的 service/CLI contract，不允许 content worker 用自然语言
自由调用 VPS agent。

### 10.5 YouTube

发现：

- channel Atom feed 取最近 15 条，video ID 为稳定 identity。
- feed poll 首版即可上线 discovery；WebSub 是后续低延迟优化。
- `UPCOMING / LIVE / FINISHED` gate 在 transcript 前执行。
- live/premiere 未结束时写 `CONTENT_DEFERRED` 并安排 metadata recheck，不提交 ASR。

字幕：

1. 对 FINISHED video 调 Supadata `mode=native`。
2. `transcript-unavailable` 时按 captions grace policy 重试。
3. grace 到期且 duration/budget/profile 允许时，调用 `mode=auto`。
4. 返回 transcript 直接校验；返回 `jobId` 必须持久化并只轮询该 job。
5. job terminal 前禁止重新提交同一 video/profile；实测重复提交会产生新的 job ID。
6. `completed` 后持久化 segments；`failed` 保存 provider failure，不生成空 transcript。

首版 captions grace profiles：

| Profile | Native attempts | Generated decision |
| --- | --- | --- |
| Standard upload | FINISHED +10m、+45m | +60m；需 `allowGenerated`、未过 `maxContentAge` |
| Live replay | FINISHED +30m、+2h | +6h；需时长和 freshness gate |
| Longform low priority | FINISHED +30m、+6h | 默认不 generated，只保留 metadata/deferred |

每次 attempt 都复用已知 terminal result；已有 transcript revision 或 pending provider job 时不再
调用 native/auto。profile revision 进入 request hash，改变 grace/cost policy 不改写历史 run。

2026-08-22 probe 已证明：

- Supadata native 的 105 个 text/offset/duration segments 与本机直接取得的 YouTube 人工字幕逐段
  hash 完全一致。
- Supadata 把 `en-GB` 人工轨和 `en` 自动轨折叠为 `en`，且不返回 manual/auto 标识，因此
  `trackKind` 必须为 `UNKNOWN`。
- Supadata 对公开 11 秒音频的 generated ASR 返回 2 segments，文字与标准 reference 一致。
- 一个 119 秒、已结束、无字幕的 FPL 视频在 `native` 下返回
  `transcript-unavailable`，`auto` 约 37 秒返回 job ID。
- 匿名 Playground 无法访问 job status；direct status API 返回 401。带 API key 的 VPS
  `completed/failed`、segments、latency 和 billable units 尚未验收。
- 对两个已有字幕的 YouTube 视频强制 `generate` 出现空内容或 `invalid-request`，不能把
  anonymous Playground 当作生产 SLA 证据。

因此首版开关分离为 native 和 generated；native 可进入带 key shadow，generated 保持关闭直至
异步验收完成。

## 11. 数据质量 Gates

### 11.1 共用 gates

1. Process：正常退出、未超时、UTF-8 完整、输出未超限。
2. Transport：允许的 scheme/host、status/content type、redirect、body size 合法。
3. Trace：X 恰好一次正确 tool；HTTP/provider 保存 request/response metadata hash。
4. Schema：结构、枚举、时间、长度、数组和 segment 上限合法。
5. Identity：Endpoint stable ID 与 persisted snapshot 一致；未知来源不能冒充 core。
6. Item：stable external ID、URL availability contract、published/updated time 和 content kind
   合法；`MISSING` link 可以采集但禁止进入可发布 surface。
7. Conflict：同一 run 内同 external item 的事实冲突则整批失败，不择一保存。
8. Revision：canonical hash 由 Data 生成；相同 hash 不新建 revision/outbox。
9. Rights：只保存公开允许内容；不在公共 payload 复制完整文章或 transcript。
10. Atomicity：ReceiptRevision、Observation、terminal run、checkpoint 和 outbox 同事务。

### 11.2 Transcript gates

- segment text 非空，start/end 为非负整数且 `endMs > startMs`。
- ordinal 和时间单调；重叠只能在 profile 明确允许的容差内。
- final end 不得超过已知 media duration 加容差。
- response 为空、`lang=none`、只有 job ID、job 非 terminal 都不是成功 transcript。
- provider 语言只作 provider metadata；不能推断 manual/auto 或原始 track identity。
- segment ID 包含 media/content identity、provider/engine revision、start/end 和 normalized text。
- hash 必须使用 8.3 的 Canonical Transcript Segment V1；provider-native hash 不能直接控制
  transcript revision。
- Feature/文章摘要能否生成属于第二层；第一层只报告正文/转录是否完整可用。

### 11.3 X media gates

- ReceiptRevision、gate 和延迟 outbox 必须同事务提交；相同 revision 只能创建一个 gate。
- `CHECKED_NONE` 只允许“准确目标 article 已找到且其中没有媒体”；任何 fetch、status、parse、body
  cap 或目标 article 缺失都必须是可查询失败，不能降级成无媒体成功。
- carousel 必须按 DOM ordinal 保存；实际 MIME、尺寸、bytes 和内容 hash 来自下载字节。来源 URL
  只能作为发现线索，不能成为 storage identity 或 MIME 证据。
- Storage 上传成功、DB 更新前 crash 必须能通过 authenticated GET 和 SHA-256 恢复；对象 key 不得
  overwrite。相同 hash 可跨帖子复用，同 hash 的任一引用仍需保留时 retention 不得删除。
- `COMPLETE / CHECKED_NONE / PARTIAL / UNAVAILABLE` 全部与 X run 状态分离。到期非终态的有效媒体
  coverage 是 `PARTIAL`；失败永远不能变成 `CHECKED_NONE`。

### 11.4 Result 语义

- `EMPTY`：成功检查且 source-native 结果确实为零 item。
- `CHECKED_NO_CHANGE`：304，或成功响应中的 item 全部已知且 hash 未变。
- `COMPLETED`：全部 item/revision 通过。
- `PARTIAL`：至少一个有效 source-native item 保存，另有明确 rejected item；记录原因。X 媒体状态
  由独立 gate 表达，不参与 acquisition run 结果。
- `SATURATED`：X 达当前返回阈值。
- `FAILED`：process/transport/schema/identity/trace 整体失败；不推进 checkpoint。
- `GAP`：有明确无法追补的窗口并记录证据后才推进。
- `BUDGET_DEFERRED`：因调用/credits/容量未执行；不算 provider failure，不推进 checkpoint。
- `CONTENT_DEFERRED`：item 已发现，但 live、grace、时长或内容入口尚未满足；discovery checkpoint
  可以推进，content job 自己的 checkpoint/terminal 不伪装成功。

`COMPLETED / CHECKED_NO_CHANGE / EMPTY` 才能正常推进对应 schedule checkpoint。`PARTIAL` 只有
在 adapter 能证明请求窗口已完整检查、rejected item 不影响游标时推进；否则不推进。
keyword `SATURATED` 主 run 保存当前结果并推进主窗口，唯一 follow-up 负责较早窗口；follow-up
再饱和必须写 `GAP`。semantic `SATURATED` 保存当前 10 条并写 `SEMANTIC_RESULT_CAP`，不伪造
日期级搜索的时间分页。不同 stage 的 checkpoint 独立，feed discovery 成功不能替 transcript
job 声称完成。

`NOT_DUE` 只存在于 health projection，不创建假 run。

## 12. 失败、重试与恢复

- 普通 transient failure 在 1 分钟、5 分钟后各建一个新 attempt run。
- retry 必须复用上一失败 run 已持久化的 exact request、window、source snapshot、endpoint snapshot
  和 request hash；manifest 或 schedule 在两次 attempt 之间变化也不能悄悄改变被重试的工作。
- X 的第三次相同窗口失败写 `GAP` 和 `RETRY_EXHAUSTED` evidence，推进该 X checkpoint 并打开
  circuit；HTTP/feed 第三次失败打开 circuit，但不能把未知历史范围虚构成 X-style gap 或推进
  checkpoint。
- auth/quota/CLI/provider outage 打开 provider-level circuit；单 URL parse/query 错误只隔离
  Endpoint/item。
- circuit 每 30 分钟允许一次 probe；成功后自动关闭。lease expiry 计入同一 failure streak；X
  第三次 stale lease 同样形成有证据的 gap，其他 adapter 不推进 checkpoint。
- stale run 按 adapter lease 回收：HTTP 短 lease、Grok 6 分钟、长转录按 heartbeat 延长。
- feed due lag 超过最大回看时仍处理当前 feed item，并记录无法保证的历史 gap。
- bootstrap 有界跳过属于明确产品范围，不是 gap；bootstrap cutoff、上限和 skipped metrics 必须
  可查询。FML FPL 当前 feed 返回 590 集并跨 2015–2026，禁止首次启用时全量建 Receipt/STT job。
- X keyword saturation 只追补一次；semantic saturation 不追补。两次连续 keyword 主扫描低于
  threshold 后清除 saturated acceleration。
- article fetch 不可读保留 metadata Receipt 和明确 body availability；不能把导航文本当正文。
- Podcast/YouTube pending transcript 不重复下载或提交；只轮询已持久化 provider job/chunk。
- provider job terminal failure 永远不能转换成空 transcript。

## 13. 功能开关与 secret

保留并新增：

```text
CONTENT_PIPELINE_ENABLED=false
CONTENT_X_SCAN_ENABLED=false
CONTENT_HTTP_ACQUISITION_ENABLED=false
CONTENT_PODCAST_TRANSCRIPT_ENABLED=false
CONTENT_YOUTUBE_DISCOVERY_ENABLED=false
CONTENT_YOUTUBE_NATIVE_ENABLED=false
CONTENT_YOUTUBE_GENERATED_ENABLED=false
CONTENT_REAL_GROK_ENABLED=false

CONTENT_GROK_CONCURRENCY=2
CONTENT_HTTP_CONCURRENCY=4
CONTENT_HTTP_HOST_CONCURRENCY=2
CONTENT_HERMES_TRANSCRIPT_CONCURRENCY=1

CONTENT_GROK_TIMEOUT_MS=240000
CONTENT_GROK_MAX_OUTPUT_BYTES=4194304
CONTENT_GROK_EXPECTED_VERSION=1.0.5
CONTENT_GROK_RUNNER_SOCKET=/run/letletme-grok-runner/runner.sock
CONTENT_GROK_RUNNER_RELEASE_SHA=<deployed-release-sha-or-unknown>
CONTENT_HTTP_TIMEOUT_MS=40000
CONTENT_HTTP_MAX_OUTPUT_BYTES=8388608
CONTENT_SUPADATA_TIMEOUT_MS=75000
CONTENT_SUPADATA_JOB_MAX_WAIT_MS=900000
SUPADATA_API_KEY=<runtime-secret>

CONTENT_X_DAILY_CALL_LIMIT=2400
CONTENT_X_FINAL90_CALL_LIMIT=300
# Rolling 24h cap reserved for x_user_search identity resolution.
CONTENT_X_IDENTITY_CALL_LIMIT=100
# Temporary integer multiplier for recurring phase/lane caps; default is 1.
CONTENT_X_LANE_CAP_MULTIPLIER=1
CONTENT_SUPADATA_DAILY_CREDIT_LIMIT=0
CONTENT_HERMES_DAILY_AUDIO_MINUTES=0
```

`CONTENT_YOUTUBE_NATIVE_ENABLED` 必须同时要求 pipeline、Supadata key、正数 credit limit 和已
通过 provider compatibility revision。`CONTENT_YOUTUBE_GENERATED_ENABLED` 还必须要求 native
已开启、Endpoint 有 `maxGeneratedMinutes`，且 generated async terminal gate 已通过。关闭真实
provider 时 fixture 只能产生测试 run，不能制造“已检查但为空”。

## 14. 可观测性

结构化日志至少包含：

`runId / parentRunId / sourceKey / endpointKey / partitionKey / jobKind / adapterKind /
manifestHash / requestHash / phase / window / provider / providerJobIdHash / latency / accepted /
rejected / bootstrapSkipped / evidenceMode / state / failureClass / remainingBudget`

只读 health view 展示：

- 每个 Endpoint/schedule 的 next due、due lag、checkpoint age 和 cache-not-before。
- 最近成功、no-change、失败、饱和、gap 和 content deferred。
- circuit/probe、p50/p95 latency、result count 和 Candidate yield feedback。
- X call、Supadata credit、generated minutes、Hermes minutes 和 HTTP host capacity。
- identity unresolved/conflict、manifest reconcile/coverage 错误。
- pending provider jobs 及其 age；同一 item 是否存在重复 submission。

不持久化 Grok session/auth/thoughts、provider key、YouTube cookies、临时 signed media URL 或完整
raw trace。公开日志和 checklist 只记录 metadata、长度和 hash。

## 15. 实施顺序

### PR 1：Manifest、Entity/Endpoint 与 schema foundation

- 从最新 main 纳入本计划和 live probe checklist。
- 加入 YAML/Zod manifest、coverage compiler 和 CI snapshot。
- Migration A/B/C、Drizzle mapping、约束、索引、ACL 和 health view。
- reconcile、identity 状态和人工 source API `410`。
- flags 全部关闭；不改变现有 publication dispatcher。

### PR 2：通用 run engine 与 X 严格适配

- queue input 改为只含 `runId`，BullMQ `attempts=1`。
- DB claim/lease、预算、业务重试、circuit、gap 和原子 ReceiptRevision/outbox。
- Grok 四种显式 job kind、single-tool trace、query compiler 和 canonical X adapter。
- `GROK_ATTESTED_FINAL` evidence mode、strict whole-result JSON 和确定性 post gates；不得声称
  raw-result verified。
- X scan 原子创建 `SourceMediaGate` 和延迟 outbox；移除同步 public-page/media resolver，确保媒体
  fetch failure 不改变 acquisition run 或 checkpoint。
- 在宿主机 Runner 验证 Grok 1.0.5、deploy 用户认证、strict sandbox、sanitized env、固定工具面和
  Unix socket 隔离；Data 容器只验证 UDS transport 和 release/version contract，不运行 Grok。

### PR 3：Feed、Substack 与 article adapter

- RSS/Atom parser、conditional/cache floor、redirect identity、item dedup。
- Substack policy profile。
- robots-aware Readability article fetch。
- Fantasy Football Scout、SantiSignals、AllAboutFPL 的脱敏 deterministic fixtures 和 opt-in live
  probes。

### PR 4：Podcast 与 Hermes transcript adapter

- Podcast feed/GUID/enclosure/publisher transcript。
- 固定 Hermes timestamped segment contract、media hash、chunk/retry/merge。
- FML FPL 完整 episode 的资源、吞吐和恢复 benchmark；未通过前保留 duration cap。

### PR 5：YouTube provider adapter

- channel feed、live state、caption grace 和 transcript state machine。
- Supadata native、async job persistence/polling、credits 和 failure mapping。
- 先用 API key 从 VPS 复现 native exact case 和无字幕 Auto case。
- native shadow 通过后才能打开 native；generated terminal/quality/cost gate 通过后才能单独开启
  generated。

### PR 6：Source media archive

- 独立 `media-worker`、PostgreSQL gate/lease/retry、X target article inventory 和静态图片下载验证。
- 私有 Supabase Storage 的 standard upload、内容 hash 去重、crash recovery 和 season+90 retention；
  TUS 只作为显式诊断 fixture，不进入生产归档路径。
- 20 分钟 outbox release deadline、`receipt.media.updated.v1` 和 source media health view。
- 先在 retention 关闭时完成现有 X revision backfill 与对象一致性审计。

### PR 7：Shadow、容量与受控启用

- 完成 core coverage/identity，不要求动态来源先晋级。
- 每类 adapter 运行代表性 shadow batch 并记录 p50/p95、failure、no-change、yield 和成本。
- 开启顺序：reconcile → feed discovery → article → X → Podcast → YouTube native → YouTube
  generated。
- receipt outbox 最后开启；确认第二层消费关闭时不会丢事件或形成公开影响。

## 16. 测试计划

### 16.1 单元测试

- manifest schema、Entity/Endpoint 唯一性、club coverage、profile cross-reference。
- bootstrap lookback/item/content-job 上限、时间缺失拒绝、失败重试固定 cutoff。
- reconcile 幂等、pause-only、identity conflict、dynamic state transitions。
- schedule phase、cache floor、jitter、job ID、lease、retry、circuit、budget deferred。
- X query/compiler/trace：无工具、错误工具、双工具、错误 query/mode、失败 completion、final 提前、
  timeout、超限、损坏 UTF-8。
- X source media：target article missing 不能成为 `CHECKED_NONE`、carousel ordinal/alt text、
  profile/emoji/reply/quote/external preview 排除、poster/stream inventory、orig fallback、magic-byte MIME、
  size/dimension/pixel/SVG gates、SSRF/redirect/DNS rebinding、重试和 20 分钟 effective `PARTIAL`。
- Storage：content-addressed object key、hash dedupe、24 MiB standard upload、upload conflict/crash recovery、
  private bucket probe 和 shared-reference retention。
- RSS/Atom namespace、CDATA、redirect、304、200 no-change、无 validator、parser-empty。
- article robots、canonical、cross-origin redirect、body limit、Readability empty、paywall metadata。
- Podcast GUID/enclosure/publisher transcript、media hash、chunk merge和单块重试。
- YouTube live state、caption grace、native unavailable、async job、duplicate submission guard、credit
  reservation、empty/lang-none rejection。
- transcript segment ordering、duration tolerance、stable hash、provider revision change。
- Canonicalization V1 golden fixtures，包括 provider-native hash 与 canonical revision hash 不同。
- receipt identity、revision 1/2、hash reuse、outbox atomicity。

### 16.2 PostgreSQL/Redis integration

- fresh DB 和现有 schema migration；第二次 status 无待执行 migration。
- 两个 scheduler 并发只有一个 claim；enqueue failure、worker crash 和 stale reclaim。
- global/lane/provider budget 原子 reserve。
- checkpoint 单调；failed/deferred 不错误推进。
- 同一 item 经 feed/WebSub/重试只产生一个 Receipt 和需要的 revisions。
- 内容变化产生 revision 2 和 `receipt.updated.v1`；相同 payload 不产生 revision/outbox。
- revision/segment UPDATE/DELETE 被数据库拒绝。
- pending Supadata job 重启后继续 poll，不重新提交。
- ReceiptRevision、source media gate 和延迟 outbox 同事务；两个 media worker 只能 claim 一次。
- 20 分钟内完成会提前放行，worker 停止时 deadline 后仍可用；修复只产生幂等 media update event。
- Storage 成功但 DB 未提交可恢复；retention 不删除仍被其他 season 引用的对象。
- acquisition 故障不影响 publication outbox dispatcher。

### 16.3 Live opt-in probes

- X：四种 Build tools、版本、外层容器隔离、tool inventory/deny 和 single-call trace。
- X source media：用已知两图 carousel 和一个视频 post 验证 target article、DOM ordinal、orig 静态图
  归档和 stream inventory；不可用时 gate 显式失败，并确认 Grok run/checkpoint 不受影响。
- RSS：有 validator 和无 validator 各一个。
- Substack、article、Podcast：使用 checklist 的真实案例。
- YouTube native：`Xef37ImWz3M`，验证 105 segments canonical hash。
- YouTube generated：`yA8S_bMekDU`，从 `transcript-unavailable` 到 job terminal，记录 segments、
  latency 和 actual billable units。
- Provider/API key 缺失、401、quota、timeout 和 job failed 都不得生成假 `EMPTY`。

仓库验证：

```text
bun test
bun run test:integration   # 仅显式安全测试 DB/Redis
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run db:migrate:status
```

### 16.4 当前 worktree 验证记录（2026-08-22）

- PostgreSQL 15.18 fresh migration `0025`–`0029` 通过；重复 migration status 为 up to date。
- 正式 HTTP/feed scheduler-worker live batch：21/21 Endpoint terminal，19 `COMPLETED`、2
  `CHECKED_NO_CHANGE`、155 ReceiptRevision、0 `FAILED/EMPTY`。
- 正式 X live：OfficialFPL 饱和主 run + 一次 bounded follow-up；双记者 partition 的 identity 与
  combined keyword 共 3 calls，均满足 single-tool/exact-request contract。
- 宿主机 Grok Build media probe：`CPFC/2091144605710647466` 的一次 `x_thread_fetch` 成本
  USD 0.01271324，final `media=[]`；同一帖 X 公共页面确认两张 `pbs.twimg.com/media` 图片，
  VPS deploy 用户可直接读取两张 URL。媒体 enrichment 的 resolver fixture 已覆盖 carousel、视频
  poster/HLS、无媒体和网络失败；它不增加 Grok 调用。
- 83 个 X account Endpoint 完成真实 exact identity resolution；三项变更 handle 已修正后达到
  83/83 verified。
- 全新 PostgreSQL 15 上 44 个唯一 X partition + 5 个 keyword follow-up 全部完成：49/49 trace、
  0 `FAILED`、0 rejected、177 ReceiptRevision/outbox；semantic 2 `COMPLETED` + 2 `SATURATED`，
  两个 cap gap 均未触发无效 pagination。p50 19,226 ms、p95 47,903 ms，已知成本 USD
  0.49916666。
- 隔离数据库 integration：HTTP run-ID worker、Podcast publisher/Hermes、X semantic unknown-source
  attribution、YouTube async submit/poll/resume 全部通过。
- retry integration：HTTP attempt 2 复用完整 immutable request/snapshots；X attempts 1–3 保持同一
  request hash，第三次为 `GAP` 且 checkpoint/circuit 状态与 gap evidence 一致。
- YouTube provider integration 使用受控 response fixture；本机没有 Supadata/YouTube API key，不能
  把它写成 live provider pass。VPS service、目标 Docker image 和长期容量仍未验收。

## 17. 验收标准

- core manifest 中每个 Entity/Endpoint 都有稳定 key；20 家俱乐部 official 和 primary reporting
  coverage 无缺口。
- X、RSS/Atom、Substack、article、Podcast、YouTube 六类都有真实 adapter evidence。
- 每个成功 X run 证明恰好一次预期工具调用、exact request 和 strict final，并明确记录
  `GROK_ATTESTED_FINAL`；不虚报 raw-result verification。其他 adapter 有确定性
  request/response evidence。
- RSS 无 ETag/Last-Modified 仍能正确尊重 cache floor 并输出 no-change。
- VPS 不能直取 YouTube 时不会回退个人 cookies，也不会把 transport failure 写成 empty。
- Supadata native exact case通过；generated async job完成、非空 segments、成本和 terminal failure
  都可查询后，才允许开启 generated。
- 一条跨多 Endpoint/多次扫描的内容只有一个稳定 Receipt；实质变化产生 immutable revision。
- 每条 ReceiptRevision 可追溯到 Entity、Endpoint、partition/run、request、window、Observation、
  adapter/provider revision 和成本。
- Podcast/YouTube transcript segments 保留原生时间戳和稳定 hash，不由 LLM 重新切段。
- bootstrap 永远不会因长寿命 feed 创建无界历史 Receipt 或 transcript；skipped 范围可查询。
- failure、no-change、saturation、gap、budget/content deferred 在 health view 中可区分。
- 第一层只发布 ReceiptRevision outbox；不修改 GraphQL、四个 Briefing 页面、Candidate、
  presentation 或 surface publication。

在以上全部满足前，只能分别声明某个 adapter shadow ready，不能宣布第一层 production ready。
