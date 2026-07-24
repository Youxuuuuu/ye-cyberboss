# Cyberboss 仓库协作说明

## 项目角色

- Cyberboss 是运行时、消息渠道、线程状态和 Conversation Record 的所有者。
- MurmurLane 是独立的展示与 WebChat 消费项目。Cyberboss 不得导入或依赖 MurmurLane 源码。
- 本仓库是上游 Cyberboss 的扩展型 fork。新增能力优先放入独立模块，并通过窄 `interface` 接入；不要为了形式上的“零改本体”牺牲正确性。

## 稳定所有权

- `src/core/inbound-turn.js` 负责把渠道输入整理为统一的 Inbound Turn。
- `src/core/conversation/` 负责生成、规范化和持久化派生的 Conversation Record。
- `src/adapters/channel/webchat/` 负责 WebChat HTTP、SSE、上传和请求幂等传输。
- 渠道 Adapter 负责渠道特有行为；跨渠道语义应先进入统一模型，再交给 Runtime 或 Conversation。
- `CyberbossApp` 是启动与装配入口。新增能力不应默认继续扩大它的公开 `interface`；先判断是否存在可复用的真实 `seam`。

## 数据与兼容性规则

- Codex、ClaudeCode 的原始 session 文件是只读来源。不得修改、重命名、截断、清理、移动或覆盖。
- Conversation JSONL 是派生记录，只能由 Cyberboss 的 Conversation 流程写入；MurmurLane 不直接写这些文件。
- `source.sourceKey` 与 `meta.sourceKey` 是归档和实时记录对账的重要身份字段，不得随意改变含义。
- 修改 Conversation 字段、媒体结构、WebChat HTTP/SSE 事件、线程身份或 Turn 身份时，必须同时检查 `D:\study\MurmurLane` 的类型、合并逻辑和展示消费者。
- 新渠道不得依赖“未知 provider 自动落到微信”的行为。扩展路由时必须显式处理未知 provider。

## 跨仓库工作

- 同时影响 Cyberboss 与 MurmurLane 的任务使用共享 tracker，并标记 `Repo: both`。
- 先确定哪一侧拥有数据或行为，再在所有者处修改；避免在两边各自实现一套相同规范化逻辑。
- 跨仓库契约变化必须写明兼容策略、可恢复字段和不可恢复字段。
- Chat Gateway、Extension Loader、Channel Registry 等仍是候选设计；在 ADR 确认前不得当作既定架构。

## 修改原则

- 优先小范围、可验证的修改。不要借功能修改顺带重构无关模块。
- 设计新 `interface` 时追求深模块：调用方只学习少量稳定规则，复杂实现留在模块内部。
- 只有存在真实变化点时才建立 `seam`；不要为单一实现增加纯转发层。
- 新增语音、通话或媒体能力时，先定义跨渠道语义与 Conversation 表达，再实现渠道细节。

## 验证

- 基础语法检查：`npm run check`
- 完整测试：`node --test`
- WebChat、Conversation 或跨仓库契约变化还必须在 `D:\study\MurmurLane` 运行：`npm test` 与 `npm run build`
- 不以单个接口响应或局部测试代替用户可见链路验证。

## Agent skills

### 任务跟踪

Cyberboss 和 MurmurLane 共用本地 Markdown 任务跟踪目录：`D:\study\.cyberboss\engineering-tracker`。具体规则见 `docs/agents/issue-tracker.md`。

### 任务状态

共享任务采用五种标准状态，具体映射见 `docs/agents/triage-labels.md`。

### 领域文档

本仓库采用单上下文领域文档布局。探索代码前先读取 `CONTEXT.md`，具体规则见 `docs/agents/domain.md`。
