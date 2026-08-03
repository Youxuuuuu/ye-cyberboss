# Cyberboss 仓库协作说明

## 项目角色

- Cyberboss 仓库拥有 Runtime、消息 Channel、Inbound Turn、Thread、Runtime Settings、Runtime Model Catalog、Runtime Context Snapshot、Thread Usage Totals 与 Conversation 生产契约。
- 派生 Conversation Record 的具体生成、规范化与持久化属于 `src/custom/xiaoye/conversation/`；不要把这项职责笼统表述为“Cyberboss Core owns Conversation”。
- MurmurLane 是独立的展示与 WebChat 消费项目。Cyberboss 不得导入或依赖 MurmurLane 源码。
- 本仓库是上游 Cyberboss 的扩展型 fork。新增能力优先放入独立模块，并通过窄 `interface` 接入；不要为了形式上的“零改本体”牺牲正确性。

## 稳定所有权

- `src/core/inbound-turn.js` 负责把渠道输入整理为统一的 Inbound Turn。
- `src/custom/xiaoye/conversation/` 负责生成、规范化和持久化派生的 Conversation Record。
- `src/custom/xiaoye/murmurlane/webchat/` 负责 WebChat HTTP、SSE、上传和请求幂等传输。
- `src/custom/xiaoye/murmurlane/chat-service.js` 负责 MurmurLane 所需的聊天应用行为；HTTP Server 只依赖这份窄接口，不得直接依赖整个 `CyberbossApp`。
- `src/custom/xiaoye/index.js` 是自定义模块的组合根。自定义模块与 Cyberboss 核心之间的新依赖必须先收敛到这里的 `cyberbossPort`。
- 渠道 Adapter 负责渠道特有行为；跨渠道语义应先进入统一模型，再交给 Runtime 或 Conversation。
- `CyberbossApp` 是启动与装配入口。新增能力不应默认继续扩大它的公开 `interface`；先判断是否存在可复用的真实 `seam`。

## 数据与兼容性规则

- Codex、ClaudeCode 的原始 session 文件是只读来源。不得修改、重命名、截断、清理、移动或覆盖。
- Conversation JSONL 是派生记录，只能由 Cyberboss 的 Conversation 流程写入；MurmurLane 不直接写这些文件。
- `source.sourceKey` 与 `meta.sourceKey` 是归档和实时记录对账的重要身份字段，不得随意改变含义。
- 修改 Conversation 字段、媒体结构、WebChat HTTP/SSE 事件、线程身份或 Turn 身份时，必须检查 MurmurLane 的类型、合并逻辑和展示消费者。
- 新渠道不得依赖“未知 provider 自动落到微信”的行为。扩展路由时必须显式处理未知 provider。

## 跨仓库工作

- MurmurLane 架构：本地 [`../MurmurLane/docs/architecture/current-architecture.md`](../MurmurLane/docs/architecture/current-architecture.md)；GitHub：[dev/ins-chat](https://github.com/Youxuuuuu/MurmurLane/blob/dev/ins-chat/docs/architecture/current-architecture.md)。
- 共享仓库地图：本地 [`../murmurlane-stack/docs/repository-map.md`](../murmurlane-stack/docs/repository-map.md)；GitHub：[main](https://github.com/Youxuuuuu/murmurlane-stack/blob/main/docs/repository-map.md)。
- 诊断规范：本地 [`../murmurlane-stack/docs/workflow/cross-repo-diagnosis.md`](../murmurlane-stack/docs/workflow/cross-repo-diagnosis.md)；GitHub：[main](https://github.com/Youxuuuuu/murmurlane-stack/blob/main/docs/workflow/cross-repo-diagnosis.md)。
- Tracker：本地 [`../murmurlane-stack/tracker`](../murmurlane-stack/tracker)；GitHub：[main](https://github.com/Youxuuuuu/murmurlane-stack/tree/main/tracker)。
- 任务状态：本地 [`../murmurlane-stack/docs/workflow/triage-status.md`](../murmurlane-stack/docs/workflow/triage-status.md)；GitHub：[main](https://github.com/Youxuuuuu/murmurlane-stack/blob/main/docs/workflow/triage-status.md)。
- 跨仓库任务开始前依次读取 `docs/architecture.md`、上述 MurmurLane 架构、共享地图和对应 feature 的 `spec.md`。
- 只有生产契约与消费者都需修改、跨边界身份/媒体契约变化、两侧各有独立缺陷，或两侧无法兼容独立发布时使用 `Repo: both`；归属不明时才暂用 `Repo: both` 与 `Status: needs-triage`。
- Cyberboss 仍以自身 `CONTEXT.md` 和 `docs/adr/` 为领域权威。先确定数据或行为所有者，再在所有者处修改；避免在两边各自实现一套相同规范化逻辑。
- 跨仓库契约变化必须写明 `Contract change`、兼容策略、可恢复字段、不可恢复字段、发布顺序与回滚。发布顺序由兼容性决定。
- Chat Gateway、Extension Loader、Channel Registry 等仍是候选设计；在 ADR 确认前不得当作既定架构。

## 修改原则

- 修改上游既有文件或同步 `upstream` 前，必须读取 `docs/fork-maintenance.md`。
- 涉及 MurmurLane、WebChat、Conversation 或页面功能时，默认不修改 `src/core/` 和上游既有主体文件；优先检查 MurmurLane、`src/custom/xiaoye/`、现有 Port 与 Runtime/Channel Adapter。
- 修改 `src/core/` 或上游既有关键文件前，对应共享 Spec 必须记录 `Core change: none | required`、`Core decision: not-applicable | pending | approved | rejected`、批准人、日期、Core 文件、Core 所有权依据、现有 seam 无法承载的原因、上游风险、兼容/回滚与验证方案。
- `Core change: none` 时，`Core decision` 必须为 `not-applicable`。
- `Core change: required` 时，智能体必须在 `Core decision: pending` 阶段先列出拟修改的 `Core files`、所有权依据、现有 seam 无法承载的原因、上游风险、兼容、回滚和验证方案。
- `required + pending` 时不得修改任何 Core 文件。只有用户或维护者可以将 `Core decision` 改为 `approved`。批准仅覆盖当时已经列出的 `Core files`。
- 实施中如需增加或替换 Core 文件，必须把 `Core decision` 重新改为 `pending`，在 Comments 追加原因并重新获得批准。
- `rejected` 时不得修改 Core，应采用替代方案或记录 `wontfix`。
- 优先小范围、可验证的修改。不要借功能修改顺带重构无关模块。
- 设计新 `interface` 时追求深模块：调用方只学习少量稳定规则，复杂实现留在模块内部。
- 只有存在真实变化点时才建立 `seam`；不要为单一实现增加纯转发层。
- 新增语音、通话或媒体能力时，先定义跨渠道语义与 Conversation 表达，再实现渠道细节。

## 验证

- 基础语法检查：`npm run check`。
- 完整测试：`node --test`。
- WebChat、Conversation 或跨仓库契约变化时，在 MurmurLane 仓库运行其相关测试与构建。
- 不以单个接口响应或局部测试代替用户可见链路验证。

## Agent skills

### 任务跟踪

Cyberboss 和 MurmurLane 共用上述共享 Tracker；具体规则见共享仓库的 `issue-tracker.md`，仓库内入口见 `docs/agents/issue-tracker.md`。

### 任务状态

共享任务使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`completed`、`wontfix` 六种状态；权威说明见上述共享状态规则，仓库内入口见 `docs/agents/triage-labels.md`。

### 领域文档

本仓库采用单上下文领域文档布局。探索代码前先读取 `CONTEXT.md`，具体规则见 `docs/agents/domain.md`。
