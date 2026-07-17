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
    turnId: "turn-identity",
    itemId: "item-identity-1",
    text: "reply",
  });
  const assistant = adapter.getRecentEvents(inbound.cursor)
    .find((event) => event.messageKind === "assistant");
  assert.equal(assistant.itemId, "item-identity-1");
  assert.equal(assistant.record.itemId, "item-identity-1");
  assert.equal(assistant.record.meta.itemId, "item-identity-1");
  assert.equal(assistant.record.id, "web-assistant-item-identity-1");
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
    dataUrl: "data:text/plain;base64,aGVsbG8=",
    fileName: "hello.txt",
    contentType: "text/plain",
    kind: "file",
  });

  assert.equal(media.kind, "file");
  assert.equal(media.contentType, "text/plain");
  assert.ok(media.absolutePath.startsWith(path.join(stateDir, "inbox")));
  assert.equal(fs.readFileSync(media.absolutePath, "utf8"), "hello");
});
