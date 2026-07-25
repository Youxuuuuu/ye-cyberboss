const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
  ConversationArchive,
  ConversationImporter,
} = require("../src/custom/xiaoye/conversation")

const WORKSPACE_ROOT = "D:/study/cyberboss"

test("codex realtime preserves an independent media-only user near a text user", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-visible-media-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const sourceFile = path.join(stateDir, "codex-visible-media.jsonl")
  const imagePath = path.join(stateDir, "inbox", "2026-07-25", "fixture.png")
  fs.mkdirSync(path.dirname(imagePath), { recursive: true })
  fs.writeFileSync(imagePath, "fixture")
  const archive = createArchive(stateDir)
  t.after(() => archive.close())

  const records = [
    codexSession("thread-media"),
    codexTurn("turn-text", "2026-07-25T08:00:00.010Z"),
    codexUser("first message", "2026-07-25T08:00:00.020Z"),
    codexTurn("turn-image", "2026-07-25T08:00:05.010Z"),
    codexUser([
      "Saved attachments:",
      `- [image] ${toSlash(imagePath)}`,
      "Use the saved local files if they are needed for the request.",
    ].join("\n"), "2026-07-25T08:00:05.020Z"),
  ]

  ingestRealtime(archive, "codex", sourceFile, records)

  const users = readDay(stateDir, "2026-07-25").filter((record) => record.type === "user")
  assert.equal(users.length, 2)
  assert.equal(users[0].text, "first message")
  assert.equal(users[1].text, "")
  assert.equal(users[1].meta.attachments[0].fileName, "fixture.png")
})

test("codex realtime and import prefer the response item assistant identity", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-assistant-id-"))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const sourceFile = path.join(rootDir, "codex-assistant-id.jsonl")
  const rawRecords = [
    codexSession("thread-assistant"),
    codexTurn("turn-assistant", "2026-07-25T08:10:00.010Z"),
    codexAgentMessage("fixture reply", "2026-07-25T08:10:01.000Z"),
    codexAssistant("msg-fixture", "fixture reply", "2026-07-25T08:10:01.010Z"),
    codexTaskComplete("2026-07-25T08:10:01.020Z"),
  ]
  writeJsonl(sourceFile, rawRecords)

  const { realtime, imported } = runBothModes({
    rootDir,
    runtimeId: "codex",
    sourceFile,
    rawRecords,
    date: "2026-07-25",
  })
  const realtimeAssistants = realtime.filter((record) => record.type === "assistant")
  const importedAssistants = imported.filter((record) => record.type === "assistant")

  assert.equal(realtimeAssistants.length, 1)
  assert.equal(importedAssistants.length, 1)
  assert.equal(realtimeAssistants[0].itemId, "msg-fixture")
  assert.equal(importedAssistants[0].itemId, "msg-fixture")
})

test("codex keeps multiple response item assistants in the same turn", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-assistant-multi-"))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const sourceFile = path.join(rootDir, "codex-assistant-multi.jsonl")
  const rawRecords = [
    codexSession("thread-assistant-multi"),
    codexTurn("turn-assistant-multi", "2026-07-25T08:20:00.010Z"),
    codexAgentMessage("first reply", "2026-07-25T08:20:01.000Z"),
    codexAssistant("msg-first", "first reply", "2026-07-25T08:20:01.010Z"),
    codexAgentMessage("second reply", "2026-07-25T08:20:02.000Z"),
    codexAssistant("msg-second", "second reply", "2026-07-25T08:20:02.010Z"),
    codexTaskComplete("2026-07-25T08:20:02.020Z"),
  ]
  writeJsonl(sourceFile, rawRecords)

  const { realtime, imported } = runBothModes({
    rootDir,
    runtimeId: "codex",
    sourceFile,
    rawRecords,
    date: "2026-07-25",
  })

  assert.deepEqual(
    realtime.filter((record) => record.type === "assistant").map((record) => record.itemId),
    ["msg-first", "msg-second"],
  )
  assert.deepEqual(
    imported.filter((record) => record.type === "assistant").map((record) => record.itemId),
    ["msg-first", "msg-second"],
  )
})

test("codex emits the agent message fallback when a turn has no assistant response item", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-assistant-fallback-"))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const sourceFile = path.join(rootDir, "codex-assistant-fallback.jsonl")
  const rawRecords = [
    codexSession("thread-assistant-fallback"),
    codexTurn("turn-assistant-fallback", "2026-07-25T08:30:00.010Z"),
    codexAgentMessage("fallback reply", "2026-07-25T08:30:01.000Z"),
    codexTaskComplete("2026-07-25T08:30:01.020Z"),
  ]
  writeJsonl(sourceFile, rawRecords)

  const { realtime, imported } = runBothModes({
    rootDir,
    runtimeId: "codex",
    sourceFile,
    rawRecords,
    date: "2026-07-25",
  })

  for (const records of [realtime, imported]) {
    const assistants = records.filter((record) => record.type === "assistant")
    assert.equal(assistants.length, 1)
    assert.equal(assistants[0].text, "fallback reply")
    assert.match(assistants[0].itemId, /^item-turn-assistant-fallback-/u)
  }
})

function createArchive(stateDir) {
  return new ConversationArchive({
    config: {
      stateDir,
      conversationDir: path.join(stateDir, "conversations"),
    },
  })
}

function ingestRealtime(archive, runtimeId, sourceFile, records) {
  records.forEach((raw, index) => {
    archive.ingestRealtimeSessionLine({
      runtimeId,
      raw,
      sourceFile,
      sourceLine: index + 1,
      workspaceRoot: WORKSPACE_ROOT,
    })
  })
}

function runBothModes({ rootDir, runtimeId, sourceFile, rawRecords, date }) {
  const realtimeDir = path.join(rootDir, "realtime")
  const importDir = path.join(rootDir, "import")
  const realtimeArchive = createArchive(realtimeDir)
  ingestRealtime(realtimeArchive, runtimeId, sourceFile, rawRecords)
  realtimeArchive.close()

  const importer = new ConversationImporter({
    config: {
      stateDir: rootDir,
      conversationDir: path.join(importDir, "conversations"),
    },
    logger: { warn() {} },
  })
  importer.importFile({ runtimeId, sourceFile, workspaceRoot: WORKSPACE_ROOT })
  return {
    realtime: readDay(realtimeDir, date),
    imported: readDay(importDir, date),
  }
}

function codexSession(threadId, timestamp = "2026-07-25T08:00:00.000Z") {
  return {
    timestamp,
    type: "session_meta",
    payload: { id: threadId, cwd: WORKSPACE_ROOT },
  }
}

function codexTurn(turnId, timestamp) {
  return {
    timestamp,
    type: "turn_context",
    payload: { turn_id: turnId, cwd: WORKSPACE_ROOT, workspace_roots: [WORKSPACE_ROOT] },
  }
}

function codexUser(text, timestamp) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  }
}

function codexAgentMessage(message, timestamp) {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "agent_message", message },
  }
}

function codexAssistant(id, text, timestamp) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  }
}

function codexTaskComplete(timestamp) {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "task_complete" },
  }
}

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8")
}

function readDay(stateDir, date) {
  return fs.readFileSync(path.join(stateDir, "conversations", `${date}.jsonl`), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function toSlash(value) {
  return String(value || "").replace(/\\/g, "/")
}
