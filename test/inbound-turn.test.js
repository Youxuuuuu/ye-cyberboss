const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildInboundDraft,
  buildMergedInboundPrepared,
} = require("../src/core/inbound-turn");

test("merged web prompt retains every source message identity", () => {
  const first = buildInboundDraft({
    provider: "web",
    senderId: "user-1",
    messageId: "message-1",
    text: "first",
    receivedAt: "2026-07-17T00:00:00.000Z",
  });
  const second = buildInboundDraft({
    provider: "web",
    senderId: "user-1",
    messageId: "message-2",
    text: "second",
    receivedAt: "2026-07-17T00:00:01.000Z",
  });
  const merged = buildMergedInboundPrepared({
    bindingKey: "binding-1",
    workspaceRoot: "D:\\study\\cyberboss",
    messages: [first, second],
  });

  assert.equal(merged.text, "first\n\nsecond");
  assert.deepEqual(
    merged.sourceMessages.map((message) => message.messageId),
    ["message-1", "message-2"],
  );
  assert.equal(merged.messageId, "message-2");
});
