# Cyberboss 当前架构

## 文档定位

本文档描述当前源码已经落地的架构，是判断新功能所有权、运行时数据流和依赖方向的首要入口。

- `CONTEXT.md`：稳定领域词汇。
- `AGENTS.md`：修改与跨仓库协作约束。
- `docs/adr/`：已经接受、不可静默改变的架构决策。
- `src/custom/xiaoye/README.md`：Xiaoye 扩展目录与 Port 摘要。
- `D:\study\MurmurLane\docs\architecture\current-architecture.md`：MurmurLane 独立项目的消费侧架构。

需求 tracker 和实施 `spec.md` 记录讨论与验收，不代替当前架构文档。

## 一句话架构

> Cyberboss 拥有 Channel、Inbound Turn、Thread、Runtime、Runtime Settings、Usage 与 Conversation；Xiaoye 是扩展能力的组合根；MurmurLane 通过 WebChat 和 Conversation 契约消费结果，不拥有 Runtime 事实。

不要以“完全不动 Core”为目标。跨渠道、跨 Runtime 的真实语义属于 Core 时，应放在 Core 的独立深模块中，再通过窄 interface 暴露；前端、Transport 或 Conversation 不得各自重建一份权威状态。

## 系统与模块所有权

| 语义 | 权威模块 |
| --- | --- |
| 渠道接收与渠道特有发送 | `src/adapters/channel/*` |
| 统一用户输入 | `src/core/inbound-turn.js` |
| Turn 调度、审批和生命周期装配 | `src/core/app.js` 与相应 Core 模块 |
| Codex / ClaudeCode 生命周期和原始事件 | `src/adapters/runtime/*` |
| Workspace 当前模型、Provider 与 Effort 命令 | `src/core/runtime-settings-service.js` |
| Runtime 真实模型目录及刷新 | Runtime Adapter 与 `src/adapters/runtime/shared/runtime-model-catalog.js` |
| Runtime-scoped Workspace 参数与目录 LKG | Runtime SessionStore |
| 最近一次 Runtime Context | `src/core/thread-state-store.js` |
| Thread 累计真实 Usage | `src/core/thread-usage-ledger.js` |
| Conversation Record 生成和持久化 | `src/custom/xiaoye/conversation/` |
| WebChat 应用行为 | `src/custom/xiaoye/murmurlane/chat-service.js` |
| WebChat HTTP、SSE、上传和幂等 | `src/custom/xiaoye/murmurlane/webchat/` |
| 自定义能力装配 | `src/custom/xiaoye/index.js` |
| Conversation 与 WebChat 的页面消费 | 独立 MurmurLane 项目 |

## 顶层装配

```text
CyberbossApp
├─ Channel Router
│  ├─ Weixin Adapter
│  └─ WebChat Adapter
├─ Runtime Adapter
│  ├─ Codex
│  └─ ClaudeCode
├─ ThreadStateStore
├─ ThreadUsageLedger
├─ RuntimeSettingsService
├─ StreamDelivery
└─ Xiaoye Composition Root
   ├─ Conversation
   └─ MurmurLane Module
      ├─ Chat Service
      └─ WebChat Transport
```

`CyberbossApp` 是启动和装配入口。它可以创建模块、连接生命周期并转交事件，但新领域规则不应直接堆入 `app.js`。

## 核心数据流

### 微信与网页输入

```text
Weixin Adapter ───────────────┐
                              ├→ Prepared Inbound
MurmurLane WebChat            │  → routePreparedInbound
→ WebChat Transport           │  → Runtime
→ Chat Service ───────────────┘  → Raw Session Record
```

WebChat 不建立第二套 Runtime，也不绕过统一 Inbound Turn 直接写 Conversation。

### Runtime 输出与 Conversation

```text
Raw Runtime Event
├→ StreamDelivery → Channel Router → Weixin / WebChat SSE
├→ ThreadStateStore → Runtime Context Snapshot
├→ ThreadUsageLedger → Thread Usage Totals
└→ Raw Session Tailer / Runtime Parser
   → Canonical Conversation Record
   → Conversation Archive
```

Codex 与 ClaudeCode 的差异留在 Runtime Adapter 和各自 Conversation Parser。完成规范化后，共用 Conversation Schema、Writer、媒体语义和 MurmurLane 展示契约。

### Runtime Settings

```text
微信 /model ───────────────┐
                           ├→ RuntimeSettingsService
MurmurLane model / effort ─┘  ├→ Runtime Adapter 获取真实目录与能力
                              ├→ SessionStore 原子保存 model/provider/effort
                              └→ runtime.settings.updated
                                  → WebChat SSE → MurmurLane
```

`RuntimeSettingsService` 是 Workspace Runtime Settings 的唯一命令路径。Chat Service 不直接查询模型目录、不直接写 SessionStore，也不自行发布兼容设置事件。

### Usage

```text
Runtime 权威 Usage
→ Runtime Adapter Usage Observation
→ ThreadUsageLedger 幂等累计与持久化
→ Runtime Event 携带 usageTotals
→ WebChat status / SSE
→ MurmurLane Conversation Workspace
```

Runtime Context Snapshot 与 Thread Usage Totals 是两个不同事实：前者表示最近 Runtime Context，后者表示单个 Thread 自统计边界开始的累计真实用量。Conversation Archive 和 MurmurLane 都不推断、估算或持久化第二份权威 Totals。

## 持久数据

```text
Cyberboss State Directory
├─ sessions.json
│  ├─ Thread Binding
│  ├─ Runtime-scoped Workspace model/provider/effort
│  └─ Runtime Model Catalog Last-known-good
├─ thread-usage.json
│  └─ Thread Usage Ledger
└─ conversations/
   └─ Derived Conversation JSONL
```

Codex 与 ClaudeCode 的 Raw Session Record 是只读来源。Conversation JSONL 是可重建的派生记录；只有 Cyberboss Conversation 流程可以写入。

## Xiaoye Port interface

`src/custom/xiaoye/index.js` 是 Core 与自定义模块之间的 seam。MurmurLane Chat Service 的必需 interface 是：

```text
getRuntimeAdapter
getThreadStateStore
getThreadUsageTotals
deleteThreadUsage
getRuntimeSettings
updateRuntimeSettings
resolveWorkspaceRoot
routePreparedInbound
isPathWithinRoot
buildInboundDraft
buildMergedInboundPrepared
normalizeWorkspaceRoot
```

`resolveWeixinAccount` 与 `getActiveAccountId` 只用于现有身份兼容。Xiaoye 组合根另外使用 Runtime Event、Runtime ID 和 Conversation Workspace 解析能力。

现有 `getRuntimeAdapter` 与 `getThreadStateStore` 暴露的是较宽对象。新增功能不得继续照此扩大对象暴露；出现真实变化点时，优先增加表达稳定语义的命令或查询，再逐步替代宽对象访问。

## 新功能默认位置

| 新能力 | 默认位置 | 是否通常修改 Core |
| --- | --- | --- |
| 新 Runtime 或 Runtime 原始事件 | `src/adapters/runtime/` | 需要注册或装配 |
| 跨渠道 Runtime 设置或 Usage 规则 | 独立 Core 模块 | 是 |
| 新聊天渠道 | `src/adapters/channel/` 与显式 Router 注册 | 是 |
| WebChat HTTP/SSE/上传能力 | `custom/xiaoye/murmurlane/webchat/` | 否 |
| MurmurLane 聊天应用行为 | `custom/xiaoye/murmurlane/chat-service.js` | 仅在缺少稳定 Port 时 |
| Conversation 字段、媒体和解析 | `custom/xiaoye/conversation/` | 通常否 |
| 页面 View Model 与 Commands | MurmurLane Conversation Workspace | 否 |
| 页面视觉、手势和动画 | MurmurLane View | 否 |

修改 Conversation、WebChat 契约、Thread/Turn 身份或媒体结构时，必须同时检查 MurmurLane 的类型、对账和展示消费者。

## 禁止依赖与旁路

- MurmurLane 不直接调用 Codex 或 ClaudeCode，也不读取 `sessions.json` 或 `thread-usage.json`。
- MurmurLane 不写 Conversation Archive，不累计权威 Token。
- Conversation 不修改 Raw Session Record，不拥有 Runtime Settings 或 Usage Ledger。
- Chat Service 不直接写 Runtime Settings，不自行查询和规范化真实模型目录。
- WebChat Transport 不直接依赖 `CyberbossApp`，只调用 Chat Service interface。
- Runtime Adapter 不依赖 Xiaoye 或 MurmurLane 前端源码。
- Cyberboss 不导入 MurmurLane 源码。
- 新渠道必须显式注册；不得依赖未知 provider 自动落到微信的旧行为。
- 不为单一实现增加纯转发 Facade、Manager 或 Coordinator。

## 上游同步关注点

本仓库是扩展型 fork。同步上游后优先检查：

```text
src/core/app.js
src/core/config.js
src/core/inbound-turn.js
src/core/thread-state-store.js
src/core/runtime-settings-service.js
src/core/thread-usage-ledger.js
src/adapters/runtime/codex/
src/adapters/runtime/claudecode/
src/adapters/runtime/shared/
src/adapters/channel/router.js
src/custom/xiaoye/index.js
```

检查重点是 interface 是否仍被装配、Runtime Event 身份是否保持、SessionStore 结构是否兼容，以及未知 provider 是否被错误路由。
