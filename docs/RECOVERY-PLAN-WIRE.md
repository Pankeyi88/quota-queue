# 已有任务排序计划：开发版RPC契约

状态：0.2.0-dev.1 已按本契约实现 Host 与 Client，并完成离线验收；尚未安装到现有 GUI。本契约只用于计划编辑，不授予执行权。通道、外层request/response、operator门禁沿用现有quotaQueue/dispatch。

## 操作

所有字段必选；只接受下列primitive字段，拒绝嵌套command/facts/actor/credential/URL/认证头。

| op | payload |
| --- | --- |
| planAdd | sessionId:string, batch:integer, expectedRevision:integer |
| planConfigure | maxConcurrent:integer(1..8), expectedRevision:integer |
| planPause | paused:boolean, expectedRevision:integer |
| planItemPause | id:string, paused:boolean, expectedRevision:integer |
| planRemove | id:string, expectedRevision:integer |
| planSkip | id:string, confirmed:boolean(必须true), expectedRevision:integer |
| planMove | id:string, batch:integer, position:integer, expectedRevision:integer |

batch为0-based目标批次；等于当前批次数可创建末尾新批次。planMove的position为目标批次移除该项后的插入位置，0..目标长度；移出空批次后紧凑化。运行过的项仍受core严格位置保护。所有写入都以新计划自己的expectedRevision保护，不能用旧队列revision代替；冲突要求刷新并重新确认，不静默覆盖。

planAdd先要求该session出现在宿主已有任务只读列表中，再定点inspect用户选择的session，提取实际人工root/generation及工作区身份；不从Client收taskId/generation/authorization/hostConfirmed等事实。不创建会话或消息，不接收prompt。已完成的人工turn、以及agent registry正向报告`running`的任务不得加入为ready（`task_not_recoverable`）；原停止/失败记录只能保存禁执行计划，未来恢复还需单独授权与复核。未知运行状态不当作运行，但执行能力独立为false。

目前所有新项authorization.enabled恒false；不提供enable/claim/settle或任意core command的Remote接口。缺少额度绑定允许保存quotaScopeId:null的未绑定计划，但null永远不能被authorize/claim；不得伪造额度scope。后续绑定需可信Host适配和重新授权。

## additive View

每个bootstrap和成功操作仍返回原View，并新增recoveryPlan：

```ts
{
 available:boolean,
 editable:boolean, // 仅编辑排序计划，不是执行许可
 reason:null|'recovery_plan_unavailable'|'recovery_plan_persistence_failed',
 revision:number, // plan独立revision
 maxConcurrent:number, // 1..8
 paused:boolean,
 batches:string[][], // 含只读removed/skip历史，不能为空批次
 items:Array<{
   id:string,
   sessionId:string,
   title:string,
   workspacePath:string|null,
   batchIndex:number,
   status:'ready'|'waiting_quota'|'running'|'needs_attention'|'succeeded'|'failed'|'stopped',
   paused:boolean,
   removed:boolean,
   skipped:boolean,
   authorizationEnabled:false,
   executionHeld:boolean,
   attempts:number,
   reason:'execution_capability_missing'|'removed'|'skipped'|'task_paused'|'plan_paused'|'execution_outcome_unknown',
   blockers:Array<
     'execution_outcome_unknown'|'removed'|'skipped'|'task_running'|'plan_paused'|'item_paused'|
     'authorization_disabled'|'quota_scope_unbound'|'execution_capability_missing'|'earlier_batch_incomplete'
   > // read-only diagnostic; never a Client-settable authority
 }>
}
```

available=false时也返回固定空形状revision0/maxConcurrent1/paused=true/batches[]/items[]，不以空列表冒充实际数据已加载。存储损坏不可静默重建。available=true editable=false用于存储写失败锁，此时仍可显示已可靠发布的旧快照。

写操作按**目标状态幂等**：相同目标的重试（即使仍携带旧 expectedRevision）返回当前 View 且不写入；planAdd 对“同一身份 + 同一目标批次”的重复提交幂等成功（可安全重试丢失的响应），不同批次或已移出历史仍返回 `plan_conflict`。真正的变更仍要求当前 revision，过期客户端不能覆盖较新计划。持久写入已落盘但确认丢失时，操作返回 persistence_failed 并锁定发布；重启从已落盘快照对账，不丢弃也不重复。

实现补充：schema 硬上限为 100 个任务项、50 个批次；超限加载被拒绝、超限新增失败关闭，Client 使用同一上限。planAdd 的 item id 由 `sessionId + generation` 派生稳定哈希；同一范围（含已移出历史）不能重复加入，返回 request_conflict。本轮没有 restore 操作。planMove 在移除该项后的批次数组上解释目标 batch，插入后再紧凑空批次，因此不会因空批次索引产生歧义。

原existingTasks列表仍是只读线索，selectable=false。新UI可提供“核验并加入计划”按钮：不是直接选择为可执行，而是请求Host定点核验并保存禁执行排序。按sessionId去重，已经在计划内的同会话活动项不重复加入；失败/未知身份以固定安全错误响应，不伪造列表。

Client必须对recoveryPlan严格投影，拒绝true授权、坏revision/并发/批次/引用或重复id。旧Host缺字段时默认不可编辑。接受响应时同时保护legacy revision和plan revision，较慢返回的旧计划不能覆盖新计划。

## 存储与生命周期

使用独立KV unit `quota_recovery_plan_v1`（version1, layout single, tables[], hasGlobal true），global放严格core RecoveryPlan。旧quota_queue_v1保持历史，不自动转换、不覆盖、不删除。只有新计划有写入时才setGlobal；load失败/坏版本锁定并显示错误。服务dispose先拒绝新操作，再排空已接受plan操作、关闭plan store和unit，不在dispose期间新增执行。

该独立unit不是跨进程恢复所有权证明。真实quota/execution/autoResume继续false；本轮没有真实调度、查询或授权启用。
