# Xiaoye 自定义模块

这个目录集中存放当前 Fork 为小叶与 MurmurLane 增加的能力。它不是通用插件系统，也不改变 Cyberboss 对 Runtime、线程状态和统一 Inbound Turn 的所有权。

## 目录边界

- `index.js`：自定义模块组合根，装配 Conversation 与 MurmurLane，并承接少量 Runtime、Inbound 接入。
- `conversation/`：从渠道输入或 Runtime 原始记录派生、规范化并持久化 Conversation Record。
- `murmurlane/`：MurmurLane 的服务端桥接边界。
- `murmurlane/chat-service.js`：身份、状态、模型、线程选择和消息提交等聊天应用行为。
- `murmurlane/webchat/`：稳定的 HTTP、SSE、上传、媒体访问与请求幂等传输。

依赖方向如下：

```text
CyberbossApp
  └─ cyberbossPort
      └─ custom/xiaoye
          ├─ conversation
          └─ murmurlane
              ├─ chat-service
              └─ webchat
```

WebChat Server 只调用 Chat Service；Chat Service 只通过组合根筛选后的 `cyberbossPort` 使用 Cyberboss 能力。自定义模块不得反向导入 `CyberbossApp`，Cyberboss 也不得依赖 MurmurLane 前端源码。

## 完整消息链路

```text
MurmurLane WebChat
  → WebChat Server
  → MurmurLane Chat Service
  → Cyberboss routePreparedInbound
  → 现有 Inbound Turn 流程
  → 当前 Codex 或 ClaudeCode 线程
  → Runtime 原始 JSONL
  → Conversation 实时解析
  → WebChat SSE 与 MurmurLane 展示
```

Chat Service 只能把消息交回 Cyberboss 现有入站流程，不得绕过 Runtime 直接写 Conversation。

## Cyberboss Port interface

MurmurLane Chat Service 必需使用：

- `getRuntimeAdapter`
- `getThreadStateStore`
- `getThreadUsageTotals`
- `deleteThreadUsage`
- `getRuntimeSettings`
- `updateRuntimeSettings`
- `resolveWorkspaceRoot`
- `routePreparedInbound`
- `isPathWithinRoot`
- `buildInboundDraft`
- `buildMergedInboundPrepared`
- `normalizeWorkspaceRoot`

`resolveWeixinAccount` 与 `getActiveAccountId` 是现有身份兼容能力，不属于 Runtime Settings interface。

Xiaoye 组合根另外使用：

- `applyRuntimeEventToThreadState`
- `getRuntimeId`
- `resolveConversationWorkspaceRoot`

新增 Port 方法前，应先确认它代表稳定语义，而不是把 `CyberbossApp` 的内部对象逐步暴露出去。完整所有权、数据流与扩展位置见 [`docs/architecture.md`](../../../docs/architecture.md)，Runtime Settings 与 Usage 的决定见 [`ADR-0001`](../../../docs/adr/0001-runtime-settings-and-thread-usage-have-one-owner.md)。

`CyberbossApp` 中保留的固定接入点是：创建、启动和关闭 Xiaoye 组合根；向其转交 Runtime 事件、Runtime 设置更新事件、Inbound Conversation 记录和 Runtime Turn 创建结果；以及把 WebChat Adapter 注册到现有 Channel Router。设置事件只调用 Xiaoye 组合根公开的窄方法，不直接访问其内部 MurmurLane Adapter。WebChat 活动目标和线程事件由 MurmurLane 模块维护。

## 兼容性约束

- Codex、ClaudeCode 原始 session JSONL 是只读来源。
- Conversation JSONL 仍是派生记录，字段、去重和写入行为不得因目录迁移改变。
- WebChat 路由、环境变量、端口、请求契约、SSE 游标与重连语义保持兼容。
- WebChat 输入仍通过 Cyberboss 现有的统一 Inbound Turn 与 Runtime 流程，不建立旁路。
- 微信渠道和现有 Channel Router 行为不在本模块迁移范围内。

## 问题跟踪

README 只描述当前模块 interface，不保存会过期的问题快照。已知问题和实施状态记录在共享工程 Tracker：本地 [`../murmurlane-stack/tracker`](../../../../murmurlane-stack/tracker)；GitHub：[main](https://github.com/Youxuuuuu/murmurlane-stack/tree/main/tracker)。

## 扩展方式

增加语音、媒体或通话能力时，先定义跨渠道语义与 Conversation 表达。属于 MurmurLane 的传输或应用行为放在 `murmurlane/`；属于派生记录的规范化与持久化放在 `conversation/`。只有需要调用 Cyberboss 所拥有的能力时，才扩展组合根的窄 Port。
