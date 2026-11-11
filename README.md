# quota-queue — DeepSeek Harness 插件

**quota-queue 是 DeepSeek Harness 的第三方插件**（包名 `@local/quota-queue`），面向 Host + Web，提供已有任务的额度恢复与串并行调度计划管理。当前为开发版本，能力和限制见下文；不保证任意宿主或额度服务版本均兼容。

## 使用前提与外部依赖

使用本插件的额度查询和额度恢复功能，需要先准备：

1. **DeepSeek Harness**：本插件安装在 DeepSeek Harness 中，不是 CLIProxyAPI 插件，也不是独立服务。当前包声明的宿主兼容范围为 `>=0.2.2-rc.1 <0.2.3-0`，以 `package.json` 为准。
2. **CLI Proxy API（CLIProxyAPI）**：提供模型代理服务和管理 API。需使用支持原生插件的构建，并配置管理认证。
3. **[CPA Quota API Extension（cpa-quota-api-extension）](https://github.com/dinhkarate/cpa-quota-api-extension)**：安装并启用在 CLIProxyAPI 侧，为本插件提供机器可读额度数据。安装步骤、CLIProxyAPI 版本和平台要求以该上游仓库为准；本项目不内置或代安装它。

连接关系：`DeepSeek Harness → quota-queue → CLIProxyAPI 管理 API → cpa-quota-api-extension`。

当前额度适配器只查询 Codex，按配置中的固定 `authIndex` 选择账户，读取端点：

```text
GET /v0/management/plugins/cpa-quota-api-extension/v1/quotas?provider=codex
```

上游扩展支持其他 provider，不代表本插件已支持它们。只查看或编辑本地计划不需要访问额度 API；要启用额度查询及额度恢复，则必须配置以上服务。

### DeepSeek Harness 侧配置示例

先按上游说明安装额度扩展，再通过宿主的正式插件配置入口填写 `quota-queue` 配置。以下仅为占位示例，不包含真实凭据：

```yaml
storageBackend: json
quotaSource:
  kind: cpamc
  baseUrl: https://cpa.example.com
  managementKeyEnv: CPA_MANAGEMENT_KEY
  authIndex: YOUR_AUTH_INDEX
  weeklyMinRemaining: 10
  fiveHourMinRemaining: 0
autoResume:
  enabled: false
autoContinue:
  enabled: false
```

- `baseUrl` 必须是可访问的 HTTPS origin，不带路径或查询参数；本插件不接受明文 HTTP。
- `managementKeyEnv` 是 **Host 进程环境变量的名称**，不是管理密钥本身；密钥由你在本机安全配置，不写入 YAML、仓库或浏览器代码。
- `authIndex` 必须与你要监控的账户一致，不自动切换账户。
- 恢复开关默认关闭；配置额度源不等于已授权自动执行，还需满足宿主能力与会话授权条件。
- 不要将管理 API 直接暴露到公网；优先使用私网、VPN 或受控 HTTPS 反向代理。

## 当前状态

源码版本为 **0.2.0-dev.38**。该版修复了 DSH 0.2.2 移除 `SessionController.inspect` 后“任何会话都无法加入调度计划/队列”的故障：会话日志改由公共 `sessionQuery.observeSession` 读取，缺失该能力时单独报 `capability_missing`，不再误报“任务已完成”。运行版本以当前面板的 `runtimeVersion` 为准。用户已批准[改造计划](<docs/EXISTING-TASK-RECOVERY-PLAN.md>)：只恢复已有任务，不预约新任务、不创建新会话、不重发初始完整请求。

- 新会话“预约消息”按钮、预约对话框、新任务录入及编辑入口已从客户端移除。
- Host 的旧 `addManual` / `editPending` 操作明确拒绝；旧队列记录只读，不自动迁移成可执行任务。
- 使用宿主公共 `sessionController.list` 提供已有任务只读候选。列表时间戳、`blank=false`、`running=false` 都不作为恢复授权或成功证据。
- 选定会话的完整日志经公共 `sessionQuery.observeSession(id, { signal, projectionMode: 'none' })` 读取（live 优先、replay 校验、显式释放 lease），不调用已退役的 `SessionController.inspect`，也不使用已标记弃用的同步读取器。
- 已实现独立批次计划（核心模型、独立存储 unit、7 项计划 RPC、Client 批次编辑/并发/暂停/移出/显式跳过），并有分层离线回归。
- 计划项只保存顺序：授权恒关闭、额度范围未绑定、不会执行任何任务。
- 可选**只读**额度源 `quotaSource`：固定 CPAMC 端点、固定 `authIndex`，管理密钥只从配置命名的环境变量读取；Host 只做一次 GET，不写、不切账户、不重置额度。
- 门禁按用户决定：**周剩余 ≥ 10% 且 5 小时剩余 > 0**；401/未知/过期/绑定变化一律不释放。
- 热 request-error 适配器只在 `quotaSource` 已验证、密钥存在、`autoResume.enabled` 且存储可写时挂载；只对用户开启的会话、当前失败 turn/step 生效，其他情况一律委托原策略链。
- 有效能力按激活时配置计算：配置额度源后 `quotaCheck=true`；再开启 `autoResume` 后 `autoResume=true`。静态 `CAPABILITIES` 仍为 `false`，`execution` 仍未启用（不做新任务/批次执行）。
- 历史验收覆盖额度读取、界面和会话授权开关；真实额度错误下的同 step 重试、网络中断后的继续和冷恢复发送“继续”均未完成端到端验收。原会话发送“继续”会开启新 turn，不是原 step 断点恢复。

设计与验收依据见[改造计划](<docs/EXISTING-TASK-RECOVERY-PLAN.md>)和[分层验收矩阵](<docs/ACCEPTANCE-MATRIX-0.2.md>)。矩阵及安全复核属于历史阶段记录，不代表当前版本已通过全部验收；本机部署、会话排障记录不随公开仓库发布。

## 目标使用方式

1. 在一个已有任务中显式开启“额度恢复后继续此任务”，授权只绑定当前人工请求范围。
2. 遇到可信额度错误后等待只读复查；恢复时沿用原任务、会话、模型、工作区和审批策略。
3. 多个已有任务按有序批次安排，例如 `A → [B、C] → D`；批次内有界并行，批次间成功后放行。
4. 同会话及同工作区互斥，用户停止或撤销授权后不自动重新启动。

热请求优先采用宿主 `request-error` 的同 turn/step 重试。Host 重启后原 JS 回调不再存在；原会话最小 continue 新 turn 与精确同 step 冷续跑是不同策略，必须分别说明和验收，不能冒充无损断点续跑。

## 主要模块

| 模块 | 职责 |
| --- | --- |
| [client/index.js](<client/index.js>) | 真实 slot 中的已有任务只读视图、原会话导航及旧队列历史；没有预约输入或草稿读取 |
| [host/service.js](<host/service.js>) | Cordis/Typert 服务，唯一 Remote 方法 `quotaQueue/dispatch`，所有操作均要求已认证 operator carrier |
| [host/ops.js](<host/ops.js>) | 旧快照安全管理、预约操作退役、已有任务候选投影；不启动执行 |
| [host/existing-tasks.js](<host/existing-tasks.js>) | 非激活式只读列表，过滤无人工任务正向线索的会话，不转发正文、凭据或原始异常 |
| [host/session-inspection.js](<host/session-inspection.js>) | 插件内置只读 `SessionInspection` 端口：用公共 `sessionQuery.observeSession` 读取完整 live 优先日志，替代 0.2.2 移除的 `SessionController.inspect`，并释放观测 lease |
| [host/continue-transport.js](<host/continue-transport.js>) | 未挂载的实验传输：向原会话发送固定“继续”，不提供自动调度 |
| [host/continue-failure.js](<host/continue-failure.js>)、[host/continue-evidence.js](<host/continue-evidence.js>)、[host/continue-inbox.js](<host/continue-inbox.js>)、[host/continue-chain.js](<host/continue-chain.js>) | 未挂载的实验性失败分类、消息和队列对账及多轮身份关联；授权与历史 Goal 关联尚未证明 |
| [host/continue-rearm.js](<host/continue-rearm.js>) | 未挂载：人类“继续”消息后经宿主 CAS 重新武装因错误失活的 Goal；paused/blocked 不动 |
| [host/cold-identity.js](<host/cold-identity.js>)、[host/cold-transport-port.js](<host/cold-transport-port.js>)、[core/cold-recovery.mjs](<core/cold-recovery.mjs>) | 未挂载的实验身份转换、传输适配与持久 fence；仅单实例串行化，不提供跨进程所有权 |
| [host/task-identity.js](<host/task-identity.js>) | 对用户选定会话经只读 inspection 端口提取人工根消息范围；计划添加 RPC 按需使用，不批量扫描正文 |
| [core/recovery-plan.mjs](<core/recovery-plan.mjs>) | 严格已有任务批次模型、授权范围、并发上限、互斥、终态对账、持久执行占用 |
| [core/recovery-plan-store.mjs](<core/recovery-plan-store.mjs>) | 串行 apply/save/publish、revision 冲突、写失败锁与关闭排空；挂在独立 `quota_recovery_plan_v1` unit，不是跨进程 CAS |
| [core/hot-recovery.mjs](<core/hot-recovery.mjs>) | 可注入 Host 端口的等待协调器，身份/绑定前后复查、查询合并、冷却、取消及有界等待 |
| [host/hot-request-error.js](<host/hot-request-error.js>) | 公共 `agent/request-error` waterfall 适配器：仅授权时提议 retry，其余委派；满足配置条件时由生产入口挂载，并有真实 Cordis 合约测试 |
| [host/quota.js](<host/quota.js>) | 默认禁用桥；配置 CPAMC 来源并提供环境变量密钥后由 Host 只读额度源替代 |
| [scripts/build.mjs](<scripts/build.mjs>) | 入口、语法、契约及完整文件 SHA-256 清单检查 |

旧核心中保留的手动任务逻辑用于历史兼容和安全回归，不意味着 Host/Client 仍接受新增任务。

## 安全边界

- 不读取浏览器密钥，不向 Client 返回凭据引用、token、HTTP 认证头或原始错误。
- 不重置额度、不切账户、不遍历凭据、不更改原任务默认模型、不绕过审批或重放工具。
- 计划批次执行尚未启用。现有热路径将 live agent 和任务身份作为所有权证据、将配置的 scope 自匹配作为绑定证据；这尚不证明失败请求实际使用了该账户，也不是宿主级排他协议。真实自动恢复前需补齐并验证这些契约。
- 单进程持久化链、会话 writer 锁和恢复调度所有权是不同机制，不能互相替代。
- `sessionOptIns` 是会话级开关，不是按人工任务代次绑定的授权；满足热恢复配置条件时可开启，后续人工任务可能沿用该开关。
- 热协调器当前对同 turn/step 只有一次已证明的失败身份；再次耗尽的独立 attempt 关联尚待 Host 接入，不通过递增授权 generation 绕过去重。

## 构建和测试

```sh
npm test
node scripts/build.mjs --no-emit
# 完整检查并更新构建清单
npm run build
# 分模块
npm run test:core
npm run test:host
npm run test:client
```

测试包括可控端口、React/slots/Connection mock 及实际 Cordis/protocol 本地烟测。它们不等于真实额度恢复验收。真实宿主测试需要用 `DSH_MODULE_ROOT` 指向你的 DSH 安装的 `node_modules` 目录；未设置时仅尝试项目本地 `node_modules`，缺少宿主包时部分集成测试会跳过。不要把跳过当作通过。

### 本次公开上传前验证

2026-11-11，版本 `0.2.0-dev.38`：构建门禁 `node scripts/build.mjs --no-emit` 通过。显式指定本机已安装的 DSH 模块根后，完整 `npm test` 共 601 项：**580 通过、20 失败、1 跳过**，不是全绿版本。失败集中在真实宿主事件、跨重启恢复和自动继续集成场景，包括执行器不可用、agent factory 未注册、等待事件超时及断言不匹配；仍需适配和复测，不能据此声称这些路径已通过端到端验收。此次上传不修改相关执行逻辑，也不发布稳定版 Release。

本插件交付原生 ESM，不需要单独启动 Web 服务，也不运行 DSH 源码 checkout 的 watcher 来替代正式安装。

## 安装与数据保留

完整开发验收前不建议替换现有安装。后续发布只使用正式插件管理入口安装打包产物：

```sh
npm run build
npm pack --ignore-scripts
```

将生成 tarball 的绝对路径提交到现有 GUI 的“插件 → 添加插件”。不要使用源目录 link 安装，不手改 profile，不在 profile 中自行运行包管理器。Host 需要宿主 peer 包，目录 link 的 realpath 解析可能无法定位它们；使用 tarball 真实副本。

更新 Host 模块需要正常重启当前 Harness 服务；刷新 Client、禁用/启用或安装记录本身不能证明新 Host 模块代已加载。应通过 RPC 返回的编译 `runtimeVersion` 核验。不会另起服务、强杀进程或清理私有 loader 缓存规避这一要求。

旧队列仍位于宿主存储 unit `quota_queue_v1` 的 global 快照中。本轮不删除、不自动转换旧任务，暂停/撤销等保留操作沿用原快照校验。新计划使用独立生产存储 unit；其加载和保存已有离线测试，执行能力仍未启用。卸载插件不会自动删除旧快照；禁用/卸载使用正式插件页操作。不要仅根据本文猜测路径删除存储文件。

## 文档入口

- [目标与验收方案](<docs/EXISTING-TASK-RECOVERY-PLAN.md>)
- [0.2 分层验收矩阵（历史阶段记录）](<docs/ACCEPTANCE-MATRIX-0.2.md>)
- [安全边界复核（历史阶段记录）](<docs/SECURITY-REVIEW-0.2.md>)
- [批次计划 RPC 契约（历史设计）](<docs/RECOVERY-PLAN-WIRE.md>)

公开仓库不包含本机部署记录、会话截图、临时诊断数据和旧版安装包。源码公开不等于已授予开源许可证；当前仍保留 `UNLICENSED` 声明。
