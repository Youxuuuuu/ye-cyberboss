const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");
const { ThreadStateStore } = require("../src/core/thread-state-store");

test("thread state keeps approval requests in order and advances after resolving one", () => {
  const store = new ThreadStateStore();

  store.applyRuntimeEvent({
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-1",
      reason: "Tool: Bash",
      command: "echo one",
    },
  });
  store.applyRuntimeEvent({
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-2",
      reason: "Tool: Bash",
      command: "echo two",
    },
  });

  assert.equal(store.getThreadState("thread-1").pendingApproval.requestId, "req-1");
  assert.deepEqual(
    store.getThreadState("thread-1").pendingApprovals.map((entry) => entry.requestId),
    ["req-1", "req-2"],
  );

  store.resolveApproval("thread-1", "running", "req-1");

  assert.equal(store.getThreadState("thread-1").status, "waiting_approval");
  assert.equal(store.getThreadState("thread-1").pendingApproval.requestId, "req-2");
  assert.deepEqual(
    store.getThreadState("thread-1").pendingApprovals.map((entry) => entry.requestId),
    ["req-2"],
  );
});

test("handleRuntimeEvent defers later approval prompts until the current one is resolved", async () => {
  const prompts = [];
  const remembered = [];
  const cleared = [];
  const threadStateStore = new ThreadStateStore();
  const promptStateByThreadId = new Map();
  const appLike = {
    config: { stateDir: "/tmp/cyberboss-approval-queue-test" },
    threadStateStore,
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      async respondApproval() {},
      getSessionStore() {
        return {
          clearApprovalPrompt(threadId) {
            cleared.push(threadId);
            promptStateByThreadId.delete(threadId);
          },
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalCommandAllowlistForWorkspace() {
            return [];
          },
          getApprovalPromptState(threadId) {
            return promptStateByThreadId.get(threadId) || null;
          },
          rememberApprovalPrompt(threadId, requestId, signature) {
            const state = { requestId, signature };
            promptStateByThreadId.set(threadId, state);
            remembered.push({ threadId, requestId, signature });
            return state;
          },
        };
      },
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };

  const firstEvent = {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-1",
      reason: "Tool: Bash",
      command: "echo one",
      commandTokens: ["echo", "one"],
    },
  };
  const secondEvent = {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-2",
      reason: "Tool: Bash",
      command: "echo two",
      commandTokens: ["echo", "two"],
    },
  };

  threadStateStore.applyRuntimeEvent(firstEvent);
  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, firstEvent);
  threadStateStore.applyRuntimeEvent(secondEvent);
  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, secondEvent);

  assert.deepEqual(prompts.map((entry) => entry.approval.requestId), ["req-1"]);
  assert.equal(threadStateStore.getThreadState("thread-1").pendingApproval.requestId, "req-1");
  assert.deepEqual(
    threadStateStore.getThreadState("thread-1").pendingApprovals.map((entry) => entry.requestId),
    ["req-1", "req-2"],
  );
  assert.deepEqual(cleared, []);
  assert.equal(remembered.length, 1);
});

test("handleApprovalCommand prompts the next queued approval after approving the current one", async () => {
  const responses = [];
  const prompts = [];
  const sent = [];
  const remembered = [];
  const cleared = [];
  const threadStateStore = new ThreadStateStore();
  const promptStateByThreadId = new Map();
  const firstEvent = {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-1",
      reason: "Tool: Bash",
      command: "echo one",
      commandTokens: ["echo", "one"],
    },
  };
  const secondEvent = {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-2",
      reason: "Tool: Bash",
      command: "echo two",
      commandTokens: ["echo", "two"],
    },
  };
  threadStateStore.applyRuntimeEvent(firstEvent);
  threadStateStore.applyRuntimeEvent(secondEvent);

  const sessionStore = {
    buildBindingKey() {
      return "binding-1";
    },
    getThreadIdForWorkspace() {
      return "thread-1";
    },
    clearApprovalPrompt(threadId) {
      cleared.push(threadId);
      promptStateByThreadId.delete(threadId);
    },
    rememberApprovalPrefixForWorkspace() {},
    rememberApprovalPrompt(threadId, requestId, signature) {
      const state = { requestId, signature };
      promptStateByThreadId.set(threadId, state);
      remembered.push({ threadId, requestId, signature });
      return state;
    },
  };
  const appLike = {
    threadStateStore,
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      async respondApproval(payload) {
        responses.push(payload);
      },
      getSessionStore() {
        return sessionStore;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
    promptNextPendingApproval: CyberbossApp.prototype.promptNextPendingApproval,
  };

  await CyberbossApp.prototype.handleApprovalCommand.call(
    appLike,
    { workspaceId: "default", accountId: "acc-1", senderId: "user-1", contextToken: "ctx-1" },
    { name: "yes" },
  );

  assert.deepEqual(responses, [{ requestId: "req-1", decision: "accept" }]);
  assert.deepEqual(sent, ["✅ This request has been approved."]);
  assert.deepEqual(prompts.map((entry) => entry.approval.requestId), ["req-2"]);
  assert.deepEqual(cleared, ["thread-1"]);
  assert.equal(remembered.length, 1);
  assert.equal(threadStateStore.getThreadState("thread-1").pendingApproval.requestId, "req-2");
});
