# Content worker：宿主机 Grok Build Runner

> 目标设计与运行合同；不代表未通过部署验收的当前生产能力。

正式拓扑只有一条：

`content-worker → Unix socket → letletme-grok-runner(systemd) → deploy 用户 Grok Build`

Grok 子进程在 VPS 宿主机运行。Docker 容器不安装 Grok，不运行 Grok，不挂载
`auth.json`，也没有本地 fallback。

## 宿主机运行时

- systemd unit：`letletme-grok-runner.service`。
- 用户/组：`deploy` / `letletme-grok-bridge`（GID 1555）。
- Socket：`/run/letletme-grok-runner/runner.sock`，模式 0660；只有 `content-worker`
  通过同 GID 的补充组访问。
- Grok：`/home/deploy/.grok/bin/grok`，版本固定为 1.0.5。
- 环境：`HOME=/home/deploy`、`GROK_HOME=/home/deploy/.grok`、
  `GROK_NO_AUTO_UPDATE=1`。
- 执行参数使用 `--sandbox strict`、`--disable-web-search`、`--no-subagents`、
  `--no-plan`、固定 deny/disallowed tool 面和 `--max-turns 4`。
- 并发固定为 2，单次 timeout 240 秒，stdout 上限 4 MiB，请求体上限 16 KiB。

Bubblewrap、Grok binary 或版本检查失败时 Runner fail closed；不得降级为
`--sandbox none`。

## 认证

部署时由运维以 `deploy` 用户执行一次 attended device auth：

```sh
sudo -u deploy -H /home/deploy/.grok/bin/grok login --device-auth
sudo -u deploy -H /home/deploy/.grok/bin/grok models
```

认证文件只留在 `/home/deploy/.grok`。任何 workflow、Dockerfile、compose 或 Data
代码都不得读取、复制或打印 `auth.json`。认证失效时 Runner 返回明确的 provider
failure，扫描不得写 `EMPTY`、Receipt 或推进 checkpoint；恢复必须再次由运维以
`deploy` 身份执行 device auth。

## Unix-socket 协议

服务端提供：

- `GET /v1/health`：runner release、Grok 版本、strict sandbox 和最近 X probe。
- `POST /v1/executions`：固定结构化请求，一次 Grok 进程、一次预期 X 工具调用。
- `POST /v1/probes/x`：宿主机真实 `OfficialFPL` identity probe。

请求不接受任意 prompt、命令、cwd、环境变量、路径、model 或自由工具名：

```ts
type HostGrokExecutionRequestV1 = {
  schemaVersion: 1;
  runId: string;
  callerReleaseSha: string;
  toolRequest: XToolRequestV1;
};
```

Runner 只返回经过 Zod、single-tool、completion 顺序和 exact-input 校验的结构化
结果。原始 trace、thoughts、认证信息和完整错误文本只在内存中存在，不进入日志或数据库。

`runId + requestHash` 在 Runner 内存中做短期幂等；同一 run ID 的不同请求返回 409。
Runner 发送响应前发生 timeout、断开或进程异常时，响应会标记
`providerProcessStarted`；Data 依据该字段决定释放或提交预算。Data 收不到已 dispatch
请求的响应时按 provider 可能已调用处理，不自动重放。

## Data 集成

`HostGrokRunnerClient` 是 content worker 唯一的 X executor。content-worker 可以先创建
队列 runtime，但每个正式 X run 都必须在执行前验证 socket health、release SHA 和 1.0.5；
health 过期时的真实 probe 先扣该 run 的 X budget。Runner 不可用或 probe 失败只产生明确
provider failure，不会生成 `EMPTY`、Receipt 或推进 checkpoint。

执行结果的 `runMetrics` 至少记录：

- `executionLocation=HOST_RUNNER`
- `runnerReleaseSha`
- `grokVersion`
- `runnerBinaryHash`
- duration、trace hash、token/cost 元数据

`x_keyword_search`、`x_semantic_search`、`x_user_search` 和非周期性
`x_thread_fetch` 共用同一协议。失败、饱和、gap、receipt revision、outbox 和 checkpoint
语义保持不变。

## 部署顺序

1. 先以 `deploy` 身份安装锁定的 `@xai-official/grok@1.0.5`，并由 root 安装 bubblewrap。
2. root 一次性执行 `scripts/install-host-grok-runner.sh`，安装 systemd unit 和 bridge
   group（没有已部署 artifact 时只 enable，不启动 service）。
3. 以 `deploy` 身份完成一次 device auth。
4. 应用 image 构建 `/app/letletme-grok-runner` glibc standalone artifact；部署脚本将
   它提取到 `/home/workspace/letletme-grok-runner/releases/<sha>`，原子切换 `current`
   和 `current.release`，重启 Runner。
5. 先验证 `/v1/probes/x`，再验证包含最近成功 probe 的 `/v1/health`，最后重启 content worker。
6. 只有 host probe 成功后才允许 `host-shadow`；publication/public 保持关闭。

成功 probe 后，部署/host-shadow 流程会调用
`scripts/rearm-briefing-x-after-probe.sh`：它只关闭 X provider circuit、清零 failure streak，
并为 identity/recurring X schedule 设置确定性 jitter 的立即重试；不会修改 checkpoint 或历史
terminal run。

应用 image 只携带 artifact，不在容器内执行它。旧 `grok-home` volume 不由部署脚本删除，
至少保留一个 release 或 7 天，之后需单独审批清理。

## 状态与验收

`status` 必须同时报告 Runner health 和最近真实 X probe；`grok models` 成功不能单独
表示 X READY。必须能证明 Grok 子进程的 parent/cgroup 属于宿主机 Runner，而非 Docker。
Runner 对并发 probe 只允许一个进行，并对重复 probe 施加最小 60 秒间隔；status 在 health
已经新鲜时不重复发起真实 probe，host-shadow 部署仍强制执行一次真实 probe。

自动检查覆盖 UDS 缺失/拒绝、响应损坏、版本或 release 漂移、超时、输出超限、重复 run ID、
预算 pre/post-dispatch 语义和四种 X 工具 trace。CI 必须确认生产 image 不含 Grok CLI、
`auth.json`、`.grok` 或 `grok-home`。
