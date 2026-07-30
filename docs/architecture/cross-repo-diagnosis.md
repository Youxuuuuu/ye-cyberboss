# Cyberboss 与 MurmurLane 跨仓库问题诊断规范

> 文档位置：Cyberboss 仓库
>
> 适用范围：同时经过 Cyberboss 与 MurmurLane 的消息、线程、实时事件、Conversation、媒体和展示问题
>
> 最近核对：2026-07-30

## 1. 文档定位

本文是 Cyberboss 侧的跨仓库诊断规范，用于回答三个问题：

1. 用户看到的异常最早在哪个可验证环节出现；
2. 哪个仓库、模块或运行时拥有这个环节；
3. 应该先修哪里、如何验证，以及是否还存在第二个独立缺陷。

本文不建立 Cyberboss 对 MurmurLane 源码的依赖。文中提到 MurmurLane 文件，仅用于说明跨仓库契约的消费者和验证点。

本文描述的是诊断流程，不取代以下领域文档：

- Cyberboss：`CONTEXT.md`
- Cyberboss：`docs/agents/issue-tracker.md`
- Cyberboss：`docs/agents/triage-labels.md`
- MurmurLane：`D:\study\MurmurLane\CONTEXT.md`
- MurmurLane：`D:\study\MurmurLane\docs\architecture\current-architecture.md`
- MurmurLane：`D:\study\MurmurLane\docs\adr\0008-cyberboss-produces-murmurlane-consumes-conversation-contracts.md`
- MurmurLane：`D:\study\MurmurLane\docs\adr\0011-migrations-are-characterized-one-seam-at-a-time.md`
- MurmurLane：`D:\study\MurmurLane\docs\adr\0014-errors-flow-from-technical-facts-to-domain-results-to-safe-view-state.md`

如果本文与当前代码、测试或已确认 ADR 冲突，以当前代码事实和已确认 ADR 为准，并同步修订本文。

---

## 2. 核心原则

### 2.1 症状出现的位置不等于缺陷所有者

MurmurLane 页面显示错误，只能证明问题在 MurmurLane 被观察到，不能直接证明问题由 MurmurLane 产生。

同样，Cyberboss 接口返回成功，也不能单独证明：

- Runtime 已接收消息；
- 原始 session 已写入；
- Conversation 已生成；
- SSE 已被浏览器消费；
- MurmurLane 已正确合并 Live 与 Canonical 数据；
- 用户已经看到最终正确结果。

归因必须沿完整链路向前寻找第一个已经确认的契约违例。

### 2.2 第一个确认断点是修复起点，不保证是唯一缺陷

诊断时先固定一条失败样本，逐段检查同一组身份字段和载荷。

发现第一个确认断点后：

1. 在拥有该环节的仓库做最小修复；
2. 从原始入口重跑整条链路；
3. 如果下游仍然失败，继续寻找下一个独立断点；
4. 为不同所有者建立关联任务，分别修复和验证。

不得因为已经发现一个上游缺陷，就推断下游一定没有问题。也不得在没有证据时，同时对两个仓库做猜测性修改。

### 2.3 语义所有权不等于部署顺序

Cyberboss 是 Inbound Turn、Runtime 调度、线程状态和 Conversation Record 的语义所有者。MurmurLane 是 WebChat 交互、Live/Canonical 合并和展示行为的所有者。

谁定义语义，与哪个仓库先发布，是两个不同问题。发布顺序必须由兼容性决定，不能统一规定“生产端永远先行”。

### 2.4 单一事实只由一个模块生成

跨仓库数据应在所有者处生成，在消费者处解释和展示：

- Cyberboss 生成统一 Inbound Turn、线程身份、Runtime 结果和 Conversation Record；
- MurmurLane 消费 WebChat 与 Conversation 契约，不复制一套 Conversation 规范化逻辑；
- 渠道特有输入先由渠道 Adapter 转成统一语义，再交给 Runtime 或 Conversation；
- Codex、ClaudeCode 原始 session 是只读来源，不得由任何诊断或修复流程修改。

---

## 3. 所有权判定

### 3.1 Cyberboss 所有

以下问题默认从 Cyberboss 开始检查：

- 渠道输入到统一 Inbound Turn 的整理；
- WebChat HTTP、SSE、上传和请求幂等传输；
- 请求是否进入 Turn Gate；
- 请求是立即提交 Runtime，还是只进入 Cyberboss 队列；
- Runtime provider 调用、线程创建与线程恢复；
- Runtime 原始事件和原始 session 的读取；
- Runtime 特定 parser、事件映射与 Conversation 规范化；
- Conversation Record 的身份、顺序、字段、媒体结构和持久化；
- `source.sourceKey`、`meta.sourceKey` 等生产端身份语义；
- Cyberboss 返回给 MurmurLane 的技术状态。

关键模块：

- `src/core/inbound-turn.js`
- `src/core/app.js`
- `src/custom/xiaoye/index.js`
- `src/custom/xiaoye/conversation/`
- `src/custom/xiaoye/murmurlane/webchat/`
- `src/custom/xiaoye/murmurlane/chat-service.js`

### 3.2 MurmurLane 所有

以下问题默认从 MurmurLane 开始检查：

- 发送按钮、输入框、附件选择和本地预览；
- Workspace 事务状态；
- Browser Adapter 对 WebChat HTTP/SSE 的调用；
- 用户可见的 submitting、sent、failed、retrying 等状态；
- Live 数据与 Canonical 数据的对账和合并；
- AssistantTurn 分组、Thinking/Answer 展示顺序；
- 流式 reveal 时机；
- Conversation Record 的读取、筛选、搜索和展示；
- 图片、音频、文件等媒体组件的渲染与交互；
- 浏览器刷新、重连、切换日期后的视图恢复。

### 3.3 Repo: both

满足任一条件时，任务标记为 `Repo: both`：

- Conversation 字段或字段语义变化；
- WebChat HTTP/SSE 事件变化；
- 请求、消息、逻辑 Turn、线程或 Runtime 身份变化；
- 媒体结构变化；
- Live/Canonical 对账规则变化；
- 一侧修复后必须修改另一侧才能保持兼容；
- 已确认存在两个分别属于不同仓库的缺陷。

`Repo: both` 不表示两个仓库必须在同一个提交中修改。它表示任务必须记录两侧契约、验证点、发布顺序和回滚方式。

---

## 4. 任务状态与证据

跨仓库任务使用共享 tracker：

`D:\study\.cyberboss\engineering-tracker`

任务至少记录：

- `Repo: cyberboss | murmurlane | both`
- 用户可见症状；
- 最小复现步骤；
- 固定样本的身份字段；
- 已检查的链路环节；
- 当前第一个确认断点；
- 事实、推断和待验证假设；
- 兼容策略与发布顺序；
- 两个仓库各自的验证结果；
- 尚未验证的用户可见行为。

状态遵循 `docs/agents/triage-labels.md`，不得用“某个接口返回了 `{}`”或“局部测试通过”代替完成状态。

---

## 5. 第一阶段：先建立可重复的反馈回路

在修改代码前，先把问题收敛成可以重复执行的一条链路。

### 5.1 固定环境

记录：

- Cyberboss 分支和提交；
- MurmurLane 分支和提交；
- 实际运行的 Cyberboss 进程；
- 实际运行的 MurmurLane 前端和服务端；
- 共享状态目录；
- Runtime provider；
- thread、workspace、日期和时区；
- 是否存在旧进程、旧构建或浏览器缓存。

不要默认终端所在目录就是实际服务使用的代码目录。

### 5.2 固定一个最小样本

样本应尽量小，并能稳定触发症状，例如：

- 一条纯文本消息；
- 一条带单个附件的消息；
- 一个会产生 Thinking 与 Answer 的 Runtime 请求；
- 一次浏览器刷新；
- 一次 SSE 断开重连；
- 一条 Turn Gate 忙时发送的消息。

一次只改变一个变量。

### 5.3 固定观察点

至少保留：

- 浏览器请求和响应；
- Browser Adapter 返回值；
- Cyberboss WebChat ingress 日志；
- Turn Gate 决策；
- Runtime 调用结果；
- Runtime 原始事件或原始 session 片段；
- parser/mapper 输出；
- Conversation JSONL 记录；
- SSE 事件；
- MurmurLane Live/Canonical 合并结果；
- 最终视图状态。

---

## 6. 身份字段

### 6.1 当前链路中的稳定身份

根据具体链路记录可用字段：

- `requestId`
- `messageId`
- `logicalTurnId`
- `turnId`
- `threadId`
- `runtimeId`
- `clientId`
- SSE cursor 或事件序号
- Conversation `record.id`
- `source.sourceKey`
- `meta.sourceKey`
- 原始 session 文件和记录位置
- 发生时间与时区

不是每个环节都会拥有全部字段。诊断时必须记录字段从哪里产生、在哪一步恢复、在哪一步丢失。

### 6.2 `diagnosisCaseId` 只用于诊断证据

如果现有字段不足以把日志、截图和 JSONL 片段放进同一个证据包，可以在诊断笔记中分配一个本地 `diagnosisCaseId`。

它：

- 不是当前 WebChat 传输契约；
- 不是 Conversation 字段；
- 不是 Runtime 身份；
- 不得代替 `requestId`、`messageId`、`turnId` 或 `sourceKey`；
- 不得在没有架构决策的情况下写入生产数据。

`incidentId` 若出现在诊断模板中，也只具有相同的本地证据标签含义，不能被描述为现有稳定身份。

---

## 7. 兼容策略与发布顺序

所有 `Repo: both` 的契约变化都必须先分类。

| 变化类型 | 兼容策略 | 常见发布顺序 |
| --- | --- | --- |
| 新增可选字段，旧消费者会忽略未知字段 | 保留旧字段语义，新字段可缺省 | 生产端或消费端均可先行，以验证和回滚成本决定 |
| 字段重命名 | 消费端先双读，生产端再切换，最后移除旧字段 | 消费端 → 生产端 → 清理 |
| 字段语义变化 | 新字段或显式版本，禁止静默复用旧字段 | 先让消费端兼容新旧语义，再切生产端 |
| 枚举新增 | 消费端先安全处理未知值，再由生产端发送新值 | 消费端 → 生产端 |
| 删除字段 | 先证明所有消费者不再依赖，再删除 | 消费端清理 → 生产端删除 |
| 不兼容结构变化 | 版本化、双读、必要时双写，或协调发布 | 按迁移方案执行 |

每个任务必须写清：

- 旧消费者是否会忽略未知字段；
- 旧生产端缺少新字段时，消费者如何恢复；
- 哪些字段可以从其他身份重建；
- 哪些字段一旦丢失不可恢复；
- 发布顺序；
- 回滚后由哪一侧继续兼容；
- 何时可以移除旧路径。

不得把“Cyberboss 是生产端”直接推导成“Cyberboss 必须先发布”。

---

## 8. 消息发送状态：当前事实与待决契约

这一节专门避免把 HTTP `accepted`、Cyberboss 入队、Runtime 接收和用户可见 `sent` 混成同一个状态。

### 8.1 当前实现事实

截至本文最近核对时：

- Cyberboss 立即调度路径会等待 Runtime `sendTurn` 返回，再返回 `accepted: true`；
- Turn Gate 忙时，Cyberboss 可以返回 `accepted: true, queued: true`，此时只证明请求被 Cyberboss 队列接收；
- 排队响应不证明 Runtime 已经接收，也不保证此时已经存在最终 `turnId`；
- MurmurLane 当前发送事务会把一般的 `accepted: true` 处理成用户可见 `sent`，没有完整区分 `queued: true`；
- 两个仓库当前没有覆盖这一语义的完整跨仓库契约测试。

对应检查点：

- Cyberboss：`src/core/app.js`
- MurmurLane：`src/types/webChat.ts`
- MurmurLane：`src/workspaces/conversation/useConversationWorkspace.ts`

以上是当前实现描述，不是已经确认的最终产品契约。若代码改变，应同步更新本文。

### 8.2 诊断时必须区分的状态

| 观察结果 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| 浏览器开始请求 | 发送事务已启动 | Cyberboss 已接收 |
| HTTP `accepted: false` | Cyberboss 明确拒绝或失败 | 无 |
| HTTP `accepted: true, queued: true` | Cyberboss 队列接收 | Runtime 已接收、Turn 已完成、用户应显示最终 sent |
| HTTP `accepted: true` 且未排队，Runtime 调用已返回 | 当前调用已通过 Runtime 提交环节 | Conversation 已落盘、SSE 已到达、UI 已正确展示 |
| 存在 Runtime 原始记录 | Runtime 侧产生了对应记录 | Conversation parser 和 UI 正确 |
| 存在 Canonical Conversation 记录 | Conversation writer 已持久化 | MurmurLane 已读取、合并和展示 |
| UI 显示 sent | MurmurLane 本地状态进入 sent | 上游每个环节都成功 |

### 8.3 `queued` 的当前跨仓库缺口

在最终契约被确认和实现前，以下现象应作为 `Repo: both` 的契约缺口记录：

- Cyberboss 返回 `accepted: true, queued: true`；
- MurmurLane 立即展示等价于 Runtime 已接收的最终 `sent`；
- 没有后续可验证的出队、Runtime 接收或失败收敛信号。

诊断此类问题时，证据必须包含：

- `accepted`
- `status`
- `queued`
- `requestId`
- `messageId`
- `threadId`
- `turnId`
- 入队时间
- 实际出队时间
- Runtime 调用结果
- 后续失败如何传回或如何被发现

不得仅凭 `accepted: true` 关闭“消息未发送”的问题。

### 8.4 Request Ledger 的解释

Request Ledger 记录的是 Cyberboss WebChat 请求处理结果。若排队响应被持久化为 accepted，它仍然只代表当前处理阶段的接收结果。

诊断时必须检查：

- ledger 中存的完整响应；
- 该响应是否包含 `queued`；
- 幂等重放返回的是入队结果还是最终 Runtime 结果；
- 是否有后续状态覆盖或补充；
- MurmurLane 是否把幂等响应误当成最终交付结果。

---

## 9. 完整链路

跨仓库诊断至少区分四条相关但不同的链路。

### 9.1 发送与调度链路

```text
MurmurLane View
  → Conversation Workspace Transaction
  → Browser Adapter
  → Cyberboss WebChat HTTP Ingress
  → Request Ledger / Idempotency
  → Chat Service
  → cyberbossPort.routePreparedInbound
  → Inbound Turn
  → Turn Gate
      ├─ 立即 dispatch → Runtime sendTurn
      └─ queued → 稍后 dispatch → Runtime sendTurn
```

这条链路回答“请求走到了哪里”和“当前 accepted 代表哪个阶段”。

### 9.2 WebChat Live 链路

```text
Runtime Event
  → Cyberboss runtime event mapping
  → WebChat SSE projection
  → SSE transport / replay cursor
  → MurmurLane Browser Adapter
  → Live state
  → AssistantTurn grouping / reveal
  → View
```

这条链路回答“实时界面为什么这样显示”。它不能代替 Canonical 验证。

### 9.3 Canonical Conversation 链路

```text
Runtime Raw Event / Raw Session Record
  → runtime-specific source resolution
  → raw-session tail / polling
  → runtime-specific parser
  → event mapping and normalization
  → Conversation Writer
  → Conversation JSONL
  → MurmurLane Canonical reader
  → Live/Canonical reconciliation
  → AssistantTurn grouping
  → View
```

这条链路回答“归档记录实际是什么”和“刷新后为什么仍然这样显示”。

Cyberboss 当前通过 `src/custom/xiaoye/index.js` 接收 Runtime 事件和原始载荷，并把映射事件与原始数据交给 `src/custom/xiaoye/conversation/`。诊断 parser、媒体、Thinking 顺序或 `sourceKey` 时，不得从 Runtime 直接跳到最终 Conversation；必须检查中间映射和 parser 输出。

### 9.4 附件与媒体链路

```text
MurmurLane local selection / preview
  → WebChat upload
  → Cyberboss stored attachment
  → Inbound Turn media semantics
  → Runtime representation
  → Raw Session
  → Conversation media normalization
  → Conversation JSONL
  → MurmurLane media resolver
  → media component
```

本地预览成功不证明归档媒体可恢复；归档字段存在也不证明文件端点可访问。

---

## 10. 逐段检查表

### 10.1 MurmurLane 发送事务

检查：

- 点击或快捷键是否只触发一次；
- 文本和附件是否属于同一事务；
- `requestId`、`messageId` 是否稳定；
- 重试是否复用正确的幂等身份；
- submitting、queued、sent、failed 是否被错误折叠；
- 页面切换或组件卸载是否丢失待处理状态。

### 10.2 Browser Adapter

检查：

- 实际请求地址、方法和载荷；
- 超时、取消、网络失败与服务端拒绝是否区分；
- `accepted`、`queued`、`status`、`threadId`、`turnId` 是否完整保留；
- SSE 重连是否携带正确 cursor；
- 是否把未知枚举静默映射成成功。

### 10.3 Cyberboss WebChat Ingress

检查：

- 请求是否进入正确服务实例；
- schema 是否接受并保留关键字段；
- Request Ledger 是否命中旧响应；
- 上传结果是否与消息身份关联；
- HTTP 返回值对应哪个处理阶段；
- 错误是否被降级成了表面成功。

### 10.4 Inbound Turn 与 Turn Gate

检查：

- provider 和 channel 是否显式；
- workspace、thread、reply target 是否正确；
- 渠道输入是否完成统一语义转换；
- Turn Gate 是立即 dispatch 还是 queued；
- queued item 是否最终出队；
- 排队时身份字段是否足够恢复；
- 出队失败是否有可见证据。

### 10.5 Runtime

检查：

- provider 是否正确；
- `sendTurn` 是否被实际调用；
- Runtime 返回的 thread/turn 身份；
- 失败、超时、中止和重试；
- 原始事件是否属于当前样本；
- 原始 session 是否追加了对应记录。

### 10.6 Runtime 映射、parser 与 Conversation

检查：

- `event` 与 `raw` 是否同时到达组合根；
- raw source 是否解析到正确 session；
- tail/poll 是否跳过、重复或乱序；
- provider parser 是否保留角色、时间、媒体和 Thinking/Answer 语义；
- mapped event 与 raw record 是否对得上；
- Conversation writer 是否只在正确阶段持久化；
- `record.id`、`sourceKey`、thread/turn 身份是否稳定；
- Live projection 与 Canonical projection 是否表达同一语义。

### 10.7 MurmurLane Live/Canonical 合并

检查：

- Live item 和 Canonical record 使用什么身份对账；
- 刷新前后是否出现重复、丢失或顺序变化；
- Canonical 到达后是否替换了正确的 Live item；
- AssistantTurn 分组是否跨错 Turn；
- Thinking、Answer、工具和媒体是否在正确的 Turn 内；
- reveal 时机是否让正确数据以错误顺序出现。

---

## 11. 首个确认断点方法

### 11.1 为每个环节写判定句

判定句必须可由证据证明，例如：

- Browser Adapter 发出的 `requestId` 与 Cyberboss 收到的一致；
- Cyberboss 返回 `queued: true`，且 Turn Gate 日志确认进入队列；
- 队列项在指定时间内触发了 Runtime `sendTurn`；
- Runtime 原始 session 包含同一消息；
- parser 输出保留了 Thinking 与 Answer 的原始顺序；
- Conversation JSONL 中的 `sourceKey` 与原始记录一致；
- MurmurLane 将同一 Canonical record 合并到正确的 Live Turn。

“看起来像”“应该是”不算通过。

### 11.2 一次验证一个 seam

按上游到下游顺序，把每个接口标成：

- `PASS`：输入、输出和身份符合当前契约；
- `FAIL`：存在明确契约违例；
- `UNKNOWN`：证据不足；
- `NOT_REACHED`：上游尚未到达。

第一个 `FAIL` 是当前修复起点。`UNKNOWN` 不能被当成 `PASS`。

### 11.3 修复后重跑原始反馈回路

修复一个 seam 后必须重新从用户入口执行原样本，不能只调用被修改的内部函数。

如果第一个断点变成 `PASS`，但用户可见问题仍在：

- 保留已通过证据；
- 继续向下游寻找新的第一个 `FAIL`；
- 判断它是旧问题的第二个缺陷，还是新契约带来的兼容问题；
- 必要时建立关联任务。

---

## 12. 常见症状的正确归因方式

### 12.1 “界面显示已发送，但 Runtime 没收到”

不要直接归因 MurmurLane 或 Cyberboss。依次判断：

1. MurmurLane 是否实际发出请求；
2. Browser Adapter 是否收到明确响应；
3. 响应是否为 `accepted: true, queued: true`；
4. Request Ledger 是否重放了旧入队响应；
5. Turn Gate 是否实际出队；
6. Runtime `sendTurn` 是否被调用并返回；
7. MurmurLane 的 sent 是否只由 `accepted` 推导。

若响应是 `queued: true`，而 UI 立即显示最终 sent，应记录为跨仓库状态契约问题；但仍要继续查队列是否另有出队缺陷。

### 12.2 “实时看起来正确，刷新后顺序错误”

优先对比：

1. Runtime 原始事件顺序；
2. 原始 session 记录顺序；
3. runtime-specific parser 输出；
4. Conversation JSONL 顺序；
5. MurmurLane Canonical reader；
6. Live/Canonical 合并；
7. AssistantTurn 分组和 reveal 时机。

实时正确只证明 Live 链路的某些环节正确，不证明 Canonical 链路正确。

### 12.3 “后端事件顺序正确，但 Thinking 仍显示在错误位置”

后端定向测试通过后，仍必须检查：

- Live 与 Canonical 是否重复表达同一内容；
- AssistantTurn 是否把相邻记录分到了错误 Turn；
- Canonical 替换 Live 时是否改变相对顺序；
- reveal 是否按到达时间而不是语义顺序显示。

这类问题可能同时包含生产端投影缺陷和消费端合并缺陷。

### 12.4 “附件发送成功，但刷新后打不开”

依次检查：

1. 本地选择与临时预览；
2. 上传响应和存储路径；
3. Inbound Turn 中的媒体语义；
4. Runtime 原始表示；
5. Conversation 媒体规范化；
6. JSONL 中是否保留可恢复字段；
7. MurmurLane 文件端点和 URL resolver；
8. 最终媒体组件。

不要用本地 blob 预览成功证明 Canonical 媒体完整。

---

## 13. 证据包

每次诊断至少保存一份小型证据包。

建议内容：

```text
diagnosisCaseId
environment
reproduction
identity-map
browser-request
browser-response
webchat-ingress
turn-gate-decision
runtime-result
raw-session-excerpt
mapped-event
parser-output
conversation-record
sse-event
murmurlane-merge-result
final-view
```

### 13.1 隐私与不可变数据

- 原始 session 只读；
- 不得为了复现而修改、重命名、截断、清理、移动或覆盖原始 session；
- 证据包只复制必要片段；
- 删除 token、Cookie、Authorization、用户私密内容和本地敏感路径；
- 不在公开 issue 中上传完整 session；
- Conversation JSONL 也不得用手工修改来制造“修复成功”。

---

## 14. 假设、插桩与测试

### 14.1 先写假设

每个假设写成：

```text
如果 X 是原因，
那么在 seam Y 的输入会看到 A，
输出会看到 B，
身份字段 C 会保持或丢失。
```

例如：

```text
如果消息只进入 Turn Gate 队列而没有到达 Runtime，
那么 WebChat 响应会包含 queued: true，
Turn Gate 会有入队记录，
但当前时间窗口内不会出现对应 Runtime sendTurn 结果。
```

### 14.2 插桩必须可关联、可删除

临时日志应：

- 带当前样本的现有身份字段；
- 记录阶段和状态，不记录大段私密正文；
- 能区分 queued、dispatching、runtime accepted、failed；
- 在任务结束时删除，或转成有明确维护价值的诊断事件。

### 14.3 先捕获失败，再改代码

优先补最窄的失败 fixture 或契约测试：

- WebChat 响应状态测试；
- Turn Gate 入队与出队测试；
- Runtime acceptance 与 Conversation 写入时序测试；
- raw-session parser fixture；
- Conversation 字段与顺序 fixture；
- SSE replay 测试；
- MurmurLane Live/Canonical 合并测试；
- 用户可见 Turn 分组测试。

测试必须覆盖实际失败语义。仅对 helper 的单元测试，不能替代跨 seam 契约测试。

---

## 15. 修复与提交

### 15.1 修复顺序

1. 修复当前第一个确认断点；
2. 保持改动范围只覆盖拥有该行为的模块；
3. 运行该模块的定向测试；
4. 运行仓库基线；
5. 从原始入口重跑用户链路；
6. 验证另一个仓库的消费者或生产者；
7. 若仍失败，继续诊断下一断点。

### 15.2 跨仓库契约变化

任务中必须写明：

- 语义所有者；
- 新旧载荷示例；
- 双读、双写或版本化策略；
- 可恢复与不可恢复字段；
- 发布顺序；
- 回滚方式；
- 旧路径移除条件；
- 两侧测试。

### 15.3 提交组织

如果两个仓库都要修改：

- 每个提交只包含所属仓库的完整、可解释改动；
- 提交信息或 tracker 任务互相引用；
- 不把一侧的临时兼容代码描述成最终架构；
- 不为追求单次提交而破坏仓库独立性。

---

## 16. 验证

### 16.1 Cyberboss

基础验证：

```powershell
npm run check
node --test
```

对 WebChat、Conversation、Runtime 映射或 Turn Gate 的修改，还应运行相关定向测试，并保留完整测试的实际通过/失败数量。

### 16.2 MurmurLane

当问题影响 WebChat、Conversation 或跨仓库契约时：

```powershell
npm test
npm run build
```

如果仓库另有严格类型检查，按当前脚本一并运行。

### 16.3 用户可见链路

自动化测试之外，必须验证最初的用户操作：

- 发送；
- 排队与实际 dispatch；
- Runtime 回复；
- SSE 实时显示；
- 刷新后的 Canonical 恢复；
- Live/Canonical 去重；
- 媒体恢复；
- 失败与重试状态。

如果受环境限制无法完成某项验证，必须明确写成“未验证”，不能用局部成功替代。

### 16.4 基线失败

若完整测试在修改前已失败：

- 记录修改前和修改后的失败数量；
- 判断失败是否与当前改动相关；
- 保留原始错误摘要；
- 不宣称“完整测试通过”；
- 不为让数字变绿而顺手修改无关测试。

---

## 17. 禁止事项

- 不因症状在 MurmurLane 出现就直接修改 MurmurLane。
- 不因 Cyberboss 返回 `accepted: true` 就宣称 Runtime 已接收。
- 不把 `queued` 与最终 sent 视为同义词。
- 不从 Runtime 直接跳过 raw session、映射和 parser 来判断 Conversation。
- 不修改原始 Codex、ClaudeCode session。
- 不手工修改 Conversation JSONL 来掩盖生产端错误。
- 不在两个仓库复制同一套规范化规则。
- 不为单一实现增加没有真实变化点的纯转发层。
- 不把候选设计当成既定架构。
- 不把第一个发现的缺陷当成全链路唯一缺陷。
- 不在没有兼容方案时静默改变字段语义。
- 不用局部接口成功或单个定向测试代替用户可见验收。

---

## 18. 完成标准

跨仓库问题只有同时满足以下条件才可关闭：

- 原始用户症状可稳定复现，或有足够历史证据；
- 完整链路的关键 seam 已有 `PASS/FAIL/UNKNOWN` 记录；
- 第一个确认断点及其所有者有直接证据；
- 修复位于行为所有者处；
- 若有第二个缺陷，已修复或建立明确关联任务；
- 身份字段在关键环节可对账；
- `accepted`、`queued`、Runtime 接收和 UI sent 没有被混淆；
- Raw Session、映射、Conversation 与 UI 的相关结果已核对；
- 契约变化有兼容、发布和回滚方案；
- Cyberboss 与 MurmurLane 的相关测试均已执行并如实报告；
- 原始用户链路已重新验证；
- 未完成验证和已知基线失败已明确记录；
- 原始 session 未被修改；
- 两个仓库仍保持独立所有权。

一句话总结：

> 沿同一条可重复链路追踪同一组身份，找到第一个确认违例并在所有者处修复，然后从入口重跑全链路，直到用户可见结果与 Canonical 记录共同收敛。
