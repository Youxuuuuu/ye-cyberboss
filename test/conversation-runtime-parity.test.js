const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { ConversationArchive } = require("../src/custom/xiaoye/conversation")

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

function readDay(stateDir, date) {
  return fs.readFileSync(path.join(stateDir, "conversations", `${date}.jsonl`), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function toSlash(value) {
  return String(value || "").replace(/\\/g, "/")
}
