const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildInboundDraft,
  buildMergedInboundPrepared,
} = require("../src/core/inbound-turn");

test("merged web prompt keeps segment identity under one logical user message", () => {
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
    requestId: "request-1",
    messageId: "message-logical-1",
    logicalTurnId: "web:request-1",
    bubbleSegments: [
      { segmentId: "segment-1", text: "first" },
      { segmentId: "segment-2", text: "second" },
    ],
  });

  assert.equal(merged.text, "first\n\nsecond");
  assert.deepEqual(
    merged.sourceMessages.map((message) => message.messageId),
    ["message-1", "message-2"],
  );
  assert.equal(merged.requestId, "request-1");
  assert.equal(merged.messageId, "message-logical-1");
  assert.equal(merged.logicalTurnId, "web:request-1");
  assert.deepEqual(
    merged.bubbleSegments.map((segment) => segment.segmentId),
    ["segment-1", "segment-2"],
  );
});
