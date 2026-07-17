const test = require("node:test")
const assert = require("node:assert/strict")

const { ClaudeCodeProcessClient } = require("../src/adapters/runtime/claudecode/process-client")
const { mapClaudeCodeMessageToRuntimeEvent } = require("../src/adapters/runtime/claudecode/events")
const { ThreadStateStore } = require("../src/core/thread-state-store")

test("Claude raw user correlates request, transport turn, and promptId", async () => {
  const client = new ClaudeCodeProcessClient({ cwd: "D:\\study\\cyberboss" })
  const observed = []
  client.alive = true
  client.stdin = { write() {} }
  client.onMessage((event, raw) => observed.push({ event, raw }))

  await client.sendUserMessage({
    text: "first\n\nsecond",
    threadId: "thread-1",
    correlation: {
      requestId: "request-1",
      messageId: "message-1",
      logicalTurnId: "web:request-1",
    },
  })
  const transportTurnId = client.pendingTurnId
  const raw = {
    type: "user",
    sessionId: "thread-1",
    promptId: "prompt-1",
    uuid: "user-uuid-1",
    message: { role: "user", content: "first\n\nsecond" },
  }
  client.handleLine(JSON.stringify(raw))

  const correlation = observed.find(({ event }) => event.type === "turn.correlated")
  assert.ok(correlation)
  assert.equal(correlation.event.requestId, "request-1")
  assert.equal(correlation.event.messageId, "message-1")
  assert.equal(correlation.event.logicalTurnId, "web:request-1")
  assert.equal(correlation.event.transportTurnId, transportTurnId)
  assert.equal(correlation.event.canonicalTurnId, "prompt-1")

  const mapped = mapClaudeCodeMessageToRuntimeEvent(correlation.event, raw)
  assert.equal(mapped.type, "runtime.turn.correlated")
  assert.deepEqual(mapped.payload, {
    threadId: "thread-1",
    requestId: "request-1",
    messageId: "message-1",
    logicalTurnId: "web:request-1",
    displayTurnId: "web:request-1",
    transportTurnId,
    canonicalTurnId: "prompt-1",
  })
})

test("turn correlation metadata does not create or mutate runtime status", () => {
  const store = new ThreadStateStore()

  store.applyRuntimeEvent({
    type: "runtime.turn.correlated",
    payload: {
      threadId: "thread-1",
      requestId: "request-1",
      messageId: "message-1",
      logicalTurnId: "web:request-1",
      transportTurnId: "turn-1",
      canonicalTurnId: "prompt-1",
    },
  })

  assert.equal(store.getThreadState("thread-1"), null)
})
