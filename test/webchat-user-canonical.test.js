const test = require("node:test")
const assert = require("node:assert/strict")

const { CyberbossApp } = require("../src/core/app")

test("recordConversationInbound archives and publishes one merged web user", () => {
  const archived = []
  const published = []
  const app = {
    conversationArchive: {
      recordMergedWebInbound(prepared, context) {
        archived.push({ prepared, context })
        return { writtenCount: 1, warnings: [] }
      },
    },
    webChatAdapter: {
      publishInbound(input) { published.push(input) },
    },
    logConversationArchiveWarnings() {},
  }
  const prepared = {
    provider: "web",
    requestId: "request-1",
    messageId: "message-1",
    logicalTurnId: "web:request-1",
    originalText: "first\n\nsecond\n\nthird",
    bubbleSegments: [
      { segmentId: "segment-a", text: "first" },
      { segmentId: "segment-b", text: "second" },
      { segmentId: "segment-c", text: "third" },
    ],
    sourceMessages: [
      { messageId: "legacy-a", text: "first" },
      { messageId: "legacy-b", text: "second" },
      { messageId: "legacy-c", text: "third" },
    ],
  }

  CyberbossApp.prototype.recordConversationInbound.call(app, prepared, {
    runtimeId: "claudecode",
    threadId: "thread-1",
    turnId: "transport-1",
  })

  assert.equal(archived.length, 1)
  assert.equal(archived[0].prepared.messageId, "message-1")
  assert.equal(published.length, 1)
  assert.equal(published[0].prepared.messageId, "message-1")
})
