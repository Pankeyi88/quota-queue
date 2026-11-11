# Quota Queue 0.2.0-dev.1 安全复核

范围：本工作区交付的 Host/Client/Core 与打包产物。方法：源码阅读 + 离线/宿主受控测试 + 打包内容检查。**未做真实额度请求、未安装、未读取用户凭据或会话正文。**

## 1. 信任边界

| 边界 | 实现 | 证据 |
| --- | --- | --- |
| 只有已认证 Connection 的 operator 载体可调用 | 每次 `dispatch` 先验证真实 Remote invocation，并要求 `invocation.peer === ctx.get('connection').operator`；所有 15 项操作统一门禁 | `host/service.js`、`tests/host/remote-guard.test.mjs`、真实 Cordis smoke |
| 进程内直接调用不可用 | 无 invocation 即 `not_remote` | smoke-cordis |
| 模型不能冒充用户 | 不注册任何 agent tool；payload 中 `actor/role/operator/admin` 一律按非法字段拒绝 | remote-guard、wire tests |
| Client 只能收到固定投影 | View 只含白名单字段；错误只回固定码和固定摘要；不含 credentialRef、原始响应、请求头、cause | `host/views.js`、`host/errors.js`、`tests/client/error-catalog.test.mjs` |
| 计划写入不含授权事实 | Client 只能提交 primitive；`authorizationEnabled` 恒 false；无 enable/claim/settle RPC | wire tests、plan RPC tests |
| 无网络与凭据访问 | 额度桥完全不发网络；Host/Client 无 fetch/http/socket；不读 localStorage/密钥 | `host/quota.js`、Client artifact test、构建检查 |

## 2. 已覆盖的攻击/误用场景

| 场景 | 结果 |
| --- | --- |
| 伪造 peer 或缺失 Connection | `operator_required`，先于 payload 解析 |
| 直接调用服务方法 | `not_remote` |
| payload 携带 URL/header/token/authIndex/嵌套对象 | `invalid_request`，嵌套结构无法夹带 |
| 未知 Host 错误码或原始错误文本 | 折叠为固定本地文案，不回声 |
| 计划授权 true / 坏批次 / 重复 ID | Client 拒绝整个 View；Host 从不下发 true |
| 加入未列出的 sessionId | 拒绝，且**不触发**日志 inspect |
| 加入运行中/已完成任务 | `task_not_recoverable` |
| 计划无限增长 | 100 项/50 批次硬上限，超限拒绝 |
| 过期 revision 覆盖新计划 | `revision_conflict`；相同目标幂等成功 |
| 写失败或确认丢失 | 不发布候选、锁定；重启对账 |
| 重复执行/抢占 | 本版**没有任何执行、claim、settle 或 prompt RPC**；能力恒 false |
| 热重试被静默否决/重复 | 适配器仅授权时 retry，否则恰好委派一次；未挂载（构建门禁） |

## 3. 打包与供应链

- `dist/local-quota-queue-0.2.0-dev.1.tgz` 有 SHA-256 校验文件；构建清单为 86 个文件完整扫描。
- 包内**不含** `evidence/` 截图、旧 `.tgz`、`.env`、凭据或 token。
- 已在临时目录解压 tarball，直接运行包内构建门禁与全部测试：**exit 0 / 全部通过**，证明交付物自包含；当前工作区全量为 **341/341**。
- 安装必须走正式插件管理入口与正常重启；不使用源目录 link、不手改 profile、不清私有 loader 缓存。

## 4. 残余风险与限制（不隐藏）

1. **operator 载体不等于物理点击**：同一登录用户的进程内载体也能通过门禁；真正的隔离是“不把授权 setter 暴露为模型工具”，不是物理用户证明。
2. **无跨进程恢复所有权**：独立存储 unit 的单写者只是进程内/后端级保护，不能替代 Goal/always-retry/多执行者的恢复所有权协议。
3. **真实额度契约缺失**：钱包余额不符合 A02；流式 usage 不是剩余额度；不能用能力布尔值替代。
4. **热适配器未挂载**：即使挂载，always-retry 仍可能在下游拒绝后 fallback，适配器无法否决外层策略。
5. **冷恢复未实现**：Host 重启后没有精确同 step 续跑；最小 continue 新 turn 未决策。
6. **测试性质**：除真实 Cordis/protocol 本地烟测外，均为 fake ports/mocks；不等于真实额度、真实执行或真实 GUI 验收。

## 5. 复核命令

```sh
npm test                      # 341/341
node scripts/build.mjs --no-emit
# 包内自含验证（临时目录）
tar -xzf dist/local-quota-queue-0.2.0-dev.1.tgz -C <tmp>
node <tmp>/package/scripts/build.mjs --no-emit
# 在 <tmp>/package 内 npm test
```
