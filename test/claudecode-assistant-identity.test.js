const test = require("node:test")
const assert = require("node:assert/strict")

const { ClaudeCodeProcessClient } = require("../src/adapters/runtime/claudecode/process-client")
const { mapClaudeCodeMessageToRuntimeEvent } = require("../src/adapters/runtime/claudecode/events")
const { ClaudeCodeParser } = require("../src/custom/xiaoye/conversation/providers/claudecode-import")

test("Claude live completion keeps the native assistant message block identity", () => {
  const client = new ClaudeCodeProcessClient({ cwd: "D:\\study\\cyberboss" })
  const observed = []
  client.pendingTurnId = "turn-transport-1"
  client.sessionId = "thread-1"
  client.activeThreadId = "thread-1"
  client.onMessage((event, raw) => observed.push({ event, raw }))

  const assistantRaw = {
    type: "assistant",
    sessionId: "thread-1",
    uuid: "assistant-line-1",
    message: {
      id: "msg-native-1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "considering" },
        { type: "text", text: "intermediate" },
        { type: "text", text: "final answer" },
      ],
    },
  }

  client.handleAssistant(assistantRaw)
  client.handleResult({
    type: "result",
    session_id: "thread-1",
    result: "final answer",
  })

  const textEvents = observed.filter(({ event }) => event.type === "assistant.text")
  assert.deepEqual(textEvents.map(({ event }) => event.itemId), [
    "claude:msg-native-1:1",
    "claude:msg-native-1:2",
  ])

  const completed = observed.find(({ event }) => event.type === "turn.completed")
  assert.ok(completed)
  const mapped = mapClaudeCodeMessageToRuntimeEvent(completed.event, completed.raw)
  assert.equal(mapped.type, "runtime.turn.completed")
  assert.equal(mapped.payload.itemId, "claude:msg-native-1:2")
})

test("Claude archive parser uses the same native assistant item identity", () => {
  const parser = new ClaudeCodeParser({ mode: "realtime" })
  parser.parseRaw({
    raw: {
      type: "user",
      sessionId: "thread-1",
      promptId: "prompt-1",
      uuid: "user-1",
      message: { role: "user", content: "question" },
    },
    sourceFile: "session.jsonl",
    sourceLine: 1,
  })

  const records = parser.parseRaw({
    raw: {
      type: "assistant",
      sessionId: "thread-1",
      uuid: "assistant-line-1",
      parentUuid: "user-1",
      message: {
        id: "msg-native-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "considering" },
          { type: "text", text: "intermediate" },
          { type: "text", text: "final answer" },
        ],
      },
    },
    sourceFile: "session.jsonl",
    sourceLine: 2,
  })

  const assistants = records.filter((record) => record.type === "assistant")
  assert.deepEqual(assistants.map((record) => record.itemId), [
    "claude:msg-native-1:1",
    "claude:msg-native-1:2",
  ])
  assert.deepEqual(assistants.map((record) => record.meta.itemId), [
    "claude:msg-native-1:1",
    "claude:msg-native-1:2",
  ])
})

test("reply completed mapping preserves a supplied native itemId", () => {
  const mapped = mapClaudeCodeMessageToRuntimeEvent({
    type: "reply.completed",
    sessionId: "thread-1",
    turnId: "turn-transport-1",
    itemId: "claude:msg-native-1:2",
    text: "final answer",
  }, null)

  assert.equal(mapped.payload.itemId, "claude:msg-native-1:2")
})
