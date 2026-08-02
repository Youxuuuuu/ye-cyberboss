# ADR-0001：Runtime Settings 与 Thread Usage 各有一个权威所有者

Status: Accepted

## Context

微信与 MurmurLane 都需要查询和修改当前模型，MurmurLane 还需要选择 Runtime Effort、展示最近 Context 与单个 Thread 的累计真实 Usage。

如果 Chat Service、微信命令、Conversation 或前端分别查询模型目录、写 SessionStore、发布设置事件或累计 Token，同一事实会出现多个所有者，重启恢复、Runtime 差异和跨入口同步也无法保持一致。

## Decision

- Runtime Adapter 拥有如何从 Codex 或 ClaudeCode 获取真实模型目录与 Effort 能力的知识。
- Runtime SessionStore 持久化 Runtime-scoped Workspace Settings 与模型目录 Last-known-good。
- `RuntimeSettingsService` 是模型、Provider 与 Effort 的唯一查询和更新命令路径；微信和 MurmurLane 共用它。
- Runtime Adapter 产生带稳定 Runtime、Thread 和 Turn 身份的 Usage Observation。
- `ThreadUsageLedger` 是 Thread Usage Totals 的唯一累计与持久化模块。
- `ThreadStateStore` 只保存最近 Runtime Context，不承担累计规则。
- WebChat status 与 SSE 同时传输 Runtime Context Snapshot 和 Thread Usage Totals，但不重新计算它们。
- Conversation 与 MurmurLane 只消费这些事实，不估算、不回填，也不建立第二份权威状态。

## Interface consequences

Xiaoye Port 必须提供：

```text
getRuntimeSettings
updateRuntimeSettings
getThreadUsageTotals
deleteThreadUsage
```

缺少这些能力属于装配错误，应在模块创建时失败，不得静默回退到 Chat Service 自己读取 Runtime Adapter、写 SessionStore 或发布兼容事件。

## Compatibility

- `runtime.settings.updated` 是统一设置变更事件。
- 前端可以继续识别历史 `model.updated` 事件，但 Cyberboss 不再从 Chat Service 新发布该旁路事件。
- 旧 Thread 没有权威历史 Usage 时不根据消息估算；从第一笔新 Observation 开始累计。
- 永久删除 Conversation Thread 时同步删除对应 Ledger；隐藏、归档浏览和普通重启不删除。

## Consequences

- Runtime 差异和重试、LKG、Effort 校验都留在 Cyberboss 内部，调用方学习更小的 interface。
- 模型设置失败不会再触发第二条写入路径。
- 新 Runtime 或新渠道复用同一命令和累计语义，而不是扩展 MurmurLane 特例。
