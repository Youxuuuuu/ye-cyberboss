const test = require("node:test")
const assert = require("node:assert/strict")

const {
  buildWebChatRequestFingerprint,
  normalizeWebChatSendContract,
} = require("../src/custom/xiaoye/murmurlane/webchat/contract")

test("one web submit normalizes to one request, one message, and stable bubble segments", () => {
  const contract = normalizeWebChatSendContract({
    requestId: "request-1",
    messageId: "message-1",
    messages: [
      { segmentId: "segment-a", text: "first" },
      { segmentId: "segment-b", text: "second" },
      { segmentId: "segment-c", text: "third" },
    ],
  })

  assert.equal(contract.requestId, "request-1")
  assert.equal(contract.messageId, "message-1")
  assert.equal(contract.logicalTurnId, "web:request-1")
  assert.equal(contract.messages.length, 1)
  assert.equal(contract.messages[0].messageId, "message-1")
  assert.equal(contract.messages[0].text, "first\n\nsecond\n\nthird")
  assert.deepEqual(
    contract.messages[0].bubbleSegments.map((segment) => segment.segmentId),
    ["segment-a", "segment-b", "segment-c"],
  )
})

test("legacy per-segment messageIds become segment identity, never logical message identity", () => {
  const ids = ["generated-request", "generated-message"]
  const contract = normalizeWebChatSendContract({
    requestId: "request-legacy",
    messages: [
      { messageId: "legacy-a", text: "first" },
      { messageId: "legacy-b", text: "second" },
    ],
  }, { createId: () => ids.shift() })

  assert.equal(contract.messageId, "message-generated-request")
  assert.deepEqual(
    contract.messages[0].bubbleSegments.map((segment) => segment.segmentId),
    ["legacy-a", "legacy-b"],
  )
})

test("request fingerprint changes when the same requestId carries a different payload", () => {
  const base = normalizeWebChatSendContract({
    requestId: "request-fingerprint",
    messageId: "message-fingerprint",
    messages: [{ segmentId: "segment-1", text: "first" }],
  })
  const changed = normalizeWebChatSendContract({
    requestId: "request-fingerprint",
    messageId: "message-fingerprint",
    messages: [{ segmentId: "segment-1", text: "changed" }],
  })

  assert.notEqual(
    buildWebChatRequestFingerprint(base, { threadId: "thread-1" }),
    buildWebChatRequestFingerprint(changed, { threadId: "thread-1" }),
  )
})

test("duplicate bubble segment identities are rejected", () => {
  assert.throws(() => normalizeWebChatSendContract({
    requestId: "request-duplicate",
    messageId: "message-duplicate",
    messages: [{
      messageId: "message-duplicate",
      bubbleSegments: [
        { segmentId: "segment-1", text: "first" },
        { segmentId: "segment-1", text: "second" },
      ],
    }],
  }), /unique segmentId/)
})
