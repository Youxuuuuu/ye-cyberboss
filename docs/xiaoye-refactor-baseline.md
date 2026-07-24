# Xiaoye 自定义模块边界迁移基线

## Git 基线

- 分支：`dev/xiaoye`
- 迁移前提交：`389d075616048881efd2e7750e990c6fb567b310`
- 迁移前工作区：
  - `M .gitignore`
  - `?? AGENTS.md`
  - `?? CONTEXT.md`
  - `?? docs/agents/`

## 测试命令与结果

仓库的 `package.json` 没有 `npm test` 脚本，因此完整测试使用：

```powershell
node --test
```

结果：

- 测试：217
- 通过：199
- 失败：18
- 跳过：0
- 退出码：1

相关主链测试使用：

```powershell
node --test `
  test/conversation-archive.test.js `
  test/conversation-media-only-assistant.test.js `
  test/conversation-webchat-migration.test.js `
  test/webchat-adapter.test.js `
  test/webchat-contract.test.js `
  test/webchat-request-ledger.test.js `
  test/webchat-server-idempotency.test.js `
  test/webchat-sse-cursor.test.js `
  test/webchat-user-canonical.test.js `
  test/stream-delivery.test.js `
  test/codex-reconnect.test.js `
  test/claudecode-correlation.test.js `
  test/claudecode-assistant-identity.test.js
```

结果：

- 测试：71
- 通过：71
- 失败：0
- 跳过：0
- 退出码：0

仓库存在 Codex reconnect 专项测试，但没有独立命名的 ClaudeCode reconnect 测试。ClaudeCode 相关行为由完整测试集以及 correlation、assistant identity 等现有测试覆盖。

## 迁移前已知失败

以下 18 项失败在业务代码迁移前已稳定复现，本次重构不修复：

1. `claudecode adapter remembers model observed in stream messages`
2. `claudecode adapter dispatches turns only after a real session id is available`
3. `claudecode adapter does not pass a codex-selected model to Claude Code`
4. `codex session store reads runtime-scoped thread ids`
5. `codex rpc client sends image attachments as local images`
6. `sticker service exposes the current tag catalog on demand`
7. `sticker service saves inbox images as GIF stickers, grows tags, dedupes, and notifies once`
8. `sticker service saves inbox images from an items array and keeps the tag catalog deduped`
9. `sticker service updates, picks, sends, and deletes saved stickers`
10. `debounced image batches merge with a trailing text message into one prepared turn`
11. `debounced image batches still hand off to the normal pending buffer when the runtime is blocked`
12. `location arrive_home trigger enqueues a system action message`
13. `timeline service serializes structured screenshot options`
14. `turn gate tracks pending scopes until the turn is released`
15. `handlePreparedMessage queues a normal inbound message while the scope is busy`
16. `handlePreparedMessage queues while the scope is in a turn-boundary handoff`
17. `dispatchPreparedTurn binds reply target to the explicit turn id when runtime returns one`
18. `completed turns keep the boundary closed until queued inbound work has been flushed`

## 当前模块入口

### Conversation

- 公开入口：`src/core/conversation/index.js`
- 应用装配：`src/core/app.js` 调用 `createConversationArchive`
- CLI 导入：`src/index.js` 调用 `ConversationImporter`
- 迁移脚本：`scripts/migrate-legacy-webchat-conversations.js`
- 测试直接引用公开入口、Provider Parser、Source Line Resolver、Operation Normalizer 和 WebChat migration

### WebChat

- Adapter 入口：`src/adapters/channel/webchat/index.js`
- HTTP/SSE Server：`src/adapters/channel/webchat/server.js`
- 发送契约：`src/adapters/channel/webchat/contract.js`
- 请求 Ledger：`src/adapters/channel/webchat/request-ledger.js`
- 应用装配：`src/core/app.js`
- Channel Router 仍位于 `src/adapters/channel/router.js`，本轮不迁移

## 当前外部引用点

- `src/core/app.js`
- `src/index.js`
- `scripts/migrate-legacy-webchat-conversations.js`
- `package.json` 的 `check` 脚本
- Conversation、WebChat、Stream Delivery、Codex reconnect 和 ClaudeCode 相关测试
