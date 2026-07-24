const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");
const { resolveEventAfter } = require("../src/custom/xiaoye/murmurlane/webchat/server");

test("SSE reconnect uses the maximum of query after and Last-Event-ID", () => {
  assert.equal(resolveEventAfter("41", "73"), 73);
  assert.equal(resolveEventAfter("91", "73"), 91);
  assert.equal(resolveEventAfter("invalid", "17"), 17);
});

test("chat status returns the cursor from the web adapter source for the selected thread", () => {
  const cursorCalls = [];
  const status = CyberbossApp.prototype.getWebChatStatus.call({
    config: { webChatEnabled: true },
    resolveWebChatContext() {
      return {
        senderId: "user-status",
        workspaceId: "workspace-status",
        bindingKey: "binding-status",
        workspaceRoot: "D:\\study\\cyberboss",
      };
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          getThreadIdForWorkspace() { return "thread-default"; },
          getRuntimeParamsForWorkspace() { return {}; },
        };
      },
      describe() { return { id: "claudecode", model: "model-status" }; },
    },
    threadStateStore: {
      getThreadState() { return null; },
      getLatestContext() { return null; },
    },
    webChatAdapter: {
      getClientCount() { return 1; },
      getEventCursor(scope) {
        cursorCalls.push(scope);
        return 1234;
      },
    },
  }, {
    senderId: "user-status",
    threadId: "thread-selected",
  });

  assert.equal(status.eventCursor, 1234);
  assert.deepEqual(cursorCalls, [{
    senderId: "user-status",
    threadId: "thread-selected",
  }]);
});
