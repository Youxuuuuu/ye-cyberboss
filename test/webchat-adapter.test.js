const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createWebChatChannelAdapter } = require("../src/adapters/channel/webchat");

function createResponse() {
  const writes = [];
  const listeners = new Map();
  return {
    writes,
    statusCode: 0,
    setHeader() {},
    flushHeaders() {},
    write(value) {
      writes.push(String(value));
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    close() {
      listeners.get("close")?.();
    },
  };
}

test("webchat adapter replays and filters events across a draft thread", () => {
  const adapter = createWebChatChannelAdapter({
    config: {
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-webchat-")),
      webChatSenderId: "user-1",
      allowedUserIds: ["user-1"],
      webChatEnabled: true,
    },
  });
  const response = createResponse();
  adapter.subscribe(response, {
    senderId: "user-1",
    threadId: "draft-1",
    clientId: "client-1",
  });

  adapter.publish({
    kind: "thread.created",
    senderId: "user-1",
    threadId: "thread-1",
    previousThreadId: "draft-1",
  });

  assert.ok(response.writes.some((value) => value.includes('"kind":"thread.created"')));
  assert.equal(adapter.getReplyTarget("user-1"), null);

  adapter.setActiveTarget({
    userId: "user-1",
    contextToken: "web:client-1",
    clientId: "client-1",
    threadId: "thread-1",
  });
  assert.equal(adapter.getReplyTarget("user-1")?.threadId, "thread-1");

  response.close();
  assert.equal(adapter.getReplyTarget("user-1"), null);
});

test("webchat messages preserve canonical user and assistant identities", async () => {
  const adapter = createWebChatChannelAdapter({
    config: {
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-webchat-identity-")),
      webChatSenderId: "user-identity",
      allowedUserIds: ["user-identity"],
      webChatEnabled: true,
    },
  });

  const inbound = adapter.publishInbound({
    prepared: {
      senderId: "user-identity",
      messageId: "message-identity-1",
      text: "hello",
      receivedAt: "2026-07-17T00:00:00.000Z",
    },
    threadId: "thread-identity",
    turnId: "turn-identity",
  });
  assert.equal(inbound.record.messageId, "message-identity-1");
  assert.equal(inbound.record.meta.messageId, "message-identity-1");

  await adapter.sendText({
    userId: "user-identity",
    threadId: "thread-identity",
    turnId: "turn-transport-identity",
    itemId: "item-identity-1",
    requestId: "request-identity-1",
    messageId: "message-identity-1",
    logicalTurnId: "web:request-identity-1",
    displayTurnId: "web:request-identity-1",
    transportTurnId: "turn-transport-identity",
    canonicalTurnId: "prompt-canonical-identity",
    text: "reply",
  });
  const assistant = adapter.getRecentEvents(inbound.cursor)
    .find((event) => event.messageKind === "assistant");
  assert.equal(assistant.itemId, "item-identity-1");
  assert.equal(assistant.record.itemId, "item-identity-1");
  assert.equal(assistant.record.meta.itemId, "item-identity-1");
  assert.equal(assistant.record.id, "web-assistant-item-identity-1");
  assert.equal(assistant.protocolVersion, 2);
  assert.equal(assistant.displayTurnId, "web:request-identity-1");
  assert.equal(assistant.record.meta.requestId, "request-identity-1");
  assert.equal(assistant.record.meta.logicalTurnId, "web:request-identity-1");
  assert.equal(assistant.record.meta.displayTurnId, "web:request-identity-1");
  assert.equal(assistant.record.meta.transportTurnId, "turn-transport-identity");
  assert.equal(assistant.record.meta.canonicalTurnId, "prompt-canonical-identity");
});

test("runtime correlation events expose protocol-v2 turn identities", () => {
  const adapter = createWebChatChannelAdapter({
    config: {
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-webchat-turn-identity-")),
      webChatSenderId: "user-turn",
      allowedUserIds: ["user-turn"],
      webChatEnabled: true,
    },
  });

  const started = adapter.publishRuntimeEvent({
    type: "runtime.turn.started",
    payload: {
      threadId: "thread-turn",
      turnId: "turn-transport",
      requestId: "request-turn",
      messageId: "message-turn",
      logicalTurnId: "web:request-turn",
      displayTurnId: "web:request-turn",
      transportTurnId: "turn-transport",
    },
  });
  const correlated = adapter.publishRuntimeEvent({
    type: "runtime.turn.correlated",
    payload: {
      threadId: "thread-turn",
      requestId: "request-turn",
      messageId: "message-turn",
      logicalTurnId: "web:request-turn",
      displayTurnId: "web:request-turn",
      transportTurnId: "turn-transport",
      canonicalTurnId: "prompt-canonical",
    },
  });

  assert.equal(started.protocolVersion, 2);
  assert.equal(started.kind, "turn.started");
  assert.equal(started.displayTurnId, "web:request-turn");
  assert.equal(correlated.protocolVersion, 2);
  assert.equal(correlated.kind, "turn.correlated");
  assert.equal(correlated.transportTurnId, "turn-transport");
  assert.equal(correlated.canonicalTurnId, "prompt-canonical");
});

test("webchat publishes silent runtime exits as lifecycle events without visible error text", () => {
  const adapter = createWebChatChannelAdapter({
    config: {
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-webchat-silent-failure-")),
      webChatSenderId: "user-silent-failure",
      allowedUserIds: ["user-silent-failure"],
      webChatEnabled: true,
    },
  });

  const silent = adapter.publishRuntimeEvent({
    type: "runtime.turn.failed",
    payload: {
      threadId: "thread-silent",
      turnId: "turn-silent",
      text: "❌ Runtime process exited unexpectedly",
      silent: true,
    },
  });
  const detailed = adapter.publishRuntimeEvent({
    type: "runtime.turn.failed",
    payload: {
      threadId: "thread-detailed",
      turnId: "turn-detailed",
      text: "context window exceeded",
      silent: false,
    },
  });

  assert.equal(silent.kind, "turn.failed");
  assert.equal(Object.hasOwn(silent, "text"), false);
  assert.equal(detailed.kind, "error");
  assert.equal(detailed.text, "context window exceeded");
});

test("status cursor closes the snapshot-to-subscribe event gap without replaying history", () => {
  const adapter = createWebChatChannelAdapter({
    config: {
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-webchat-cursor-")),
      webChatSenderId: "user-cursor",
      allowedUserIds: ["user-cursor"],
      webChatEnabled: true,
    },
  });
  const historical = adapter.publish({
    kind: "message",
    senderId: "user-cursor",
    threadId: "thread-cursor",
    record: { id: "historical" },
  });
  const statusSnapshotCursor = adapter.getEventCursor({
    senderId: "user-cursor",
    threadId: "thread-cursor",
  });
  assert.equal(statusSnapshotCursor, historical.cursor);

  const gapEvent = adapter.publish({
    kind: "message",
    senderId: "user-cursor",
    threadId: "thread-cursor",
    record: { id: "created-after-status" },
  });
  const response = createResponse();
  adapter.subscribe(response, {
    senderId: "user-cursor",
    threadId: "thread-cursor",
    after: statusSnapshotCursor,
    clientId: "client-cursor",
  });

  const body = response.writes.join("");
  assert.equal(body.includes('"id":"historical"'), false);
  assert.equal(body.includes('"id":"created-after-status"'), true);
  assert.equal(body.includes(`id: ${gapEvent.cursor}`), true);
  response.close();
});

test("webchat upload returns an inbox media reference", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-webchat-upload-"));
  const adapter = createWebChatChannelAdapter({
    config: {
      stateDir,
      webChatSenderId: "user-1",
      allowedUserIds: ["user-1"],
      webChatEnabled: true,
      webChatMaxUploadBytes: 128,
    },
  });
  const media = await adapter.persistUpload({
    bytes: Buffer.from("hello", "utf8"),
    fileName: "hello.txt",
    contentType: "text/plain",
    kind: "file",
  });

  assert.equal(media.kind, "file");
  assert.equal(media.contentType, "text/plain");
  assert.ok(media.absolutePath.startsWith(path.join(stateDir, "inbox")));
  assert.equal(fs.readFileSync(media.absolutePath, "utf8"), "hello");
});
