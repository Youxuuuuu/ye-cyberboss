const assert = require("node:assert/strict")
const test = require("node:test")

const { createMurmurLaneChatService } = require("../src/custom/xiaoye/murmurlane/chat-service")

test("murmurlane chat service resolves identity and status through the narrow cyberboss port", () => {
  const cursorCalls = []
  const sessionStore = {
    buildBindingKey({ workspaceId, accountId, senderId }) {
      return `${workspaceId}:${accountId}:${senderId}`
    },
    getThreadIdForWorkspace() {
      return "thread-1"
    },
    getRuntimeParamsForWorkspace() {
      return { model: "model-1", modelProvider: "provider-1" }
    },
  }
  const service = createMurmurLaneChatService({
    config: {
      workspaceId: "workspace-1",
      workspaceRoot: "D:\\study\\cyberboss",
      accountId: "",
      webChatSenderId: "",
      allowedUserIds: [],
      webChatEnabled: true,
    },
    adapter: {
      getClientCount() { return 2 },
      getEventCursor(scope) {
        cursorCalls.push(scope)
        return 73
      },
    },
    cyberbossPort: {
      resolveWeixinAccount() {
        return { accountId: "account-1", userId: "user-1" }
      },
      getActiveAccountId() {
        return ""
      },
      getRuntimeAdapter() {
        return {
          getSessionStore() { return sessionStore },
          describe() { return { id: "codex", model: "fallback-model" } },
        }
      },
      getThreadStateStore() {
        return {
          getThreadState() { return null },
          getLatestContext() { return null },
        }
      },
      resolveWorkspaceRoot() {
        return "D:/study/cyberboss"
      },
      async routePreparedInbound() {
        return { accepted: true }
      },
    },
  })

  assert.deepEqual(service.getWebChatIdentity(), {
    workspaceId: "workspace-1",
    workspaceRoot: "D:/study/cyberboss",
    accountId: "account-1",
    senderId: "user-1",
  })
  assert.deepEqual(service.getWebChatStatus(), {
    connected: true,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    status: "idle",
    model: "model-1",
    modelProvider: "provider-1",
    usage: null,
    pendingApproval: null,
    webClients: 2,
    eventCursor: 73,
  })
  assert.deepEqual(cursorCalls, [{
    senderId: "user-1",
    threadId: "thread-1",
  }])
})
