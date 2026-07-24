const test = require("node:test");
const assert = require("node:assert/strict");

const { createMurmurLaneChatService } = require("../src/custom/xiaoye/murmurlane/chat-service");
const { resolveEventAfter } = require("../src/custom/xiaoye/murmurlane/webchat/server");

test("SSE reconnect uses the maximum of query after and Last-Event-ID", () => {
  assert.equal(resolveEventAfter("41", "73"), 73);
  assert.equal(resolveEventAfter("91", "73"), 91);
  assert.equal(resolveEventAfter("invalid", "17"), 17);
});

test("chat status returns the cursor from the web adapter source for the selected thread", () => {
  const cursorCalls = [];
  const sessionStore = {
    buildBindingKey() { return "binding-status"; },
    getThreadIdForWorkspace() { return "thread-default"; },
    getRuntimeParamsForWorkspace() { return {}; },
  };
  const service = createMurmurLaneChatService({
    config: {
      webChatEnabled: true,
      workspaceId: "workspace-status",
      workspaceRoot: "D:\\study\\cyberboss",
      accountId: "account-status",
      webChatSenderId: "user-status",
    },
    adapter: {
      getClientCount() { return 1; },
      getEventCursor(scope) {
        cursorCalls.push(scope);
        return 1234;
      },
    },
    cyberbossPort: {
      resolveWeixinAccount() { return null; },
      getActiveAccountId() { return "account-status"; },
      getRuntimeAdapter() {
        return {
          getSessionStore() { return sessionStore; },
          describe() { return { id: "claudecode", model: "model-status" }; },
        };
      },
      getThreadStateStore() {
        return {
          getThreadState() { return null; },
          getLatestContext() { return null; },
        };
      },
      resolveWorkspaceRoot() { return "D:\\study\\cyberboss"; },
      async routePreparedInbound() { return null; },
      findModelByQuery() { return null; },
      isPathWithinRoot() { return true; },
      buildInboundDraft(value) { return value; },
      buildMergedInboundPrepared(value) { return value; },
      normalizeWorkspaceRoot(value) { return value; },
    },
  });
  const status = service.getWebChatStatus({
    senderId: "user-status",
    threadId: "thread-selected",
  });

  assert.equal(status.eventCursor, 1234);
  assert.deepEqual(cursorCalls, [{
    senderId: "user-status",
    threadId: "thread-selected",
  }]);
});
