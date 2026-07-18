const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  migrateLegacyWebChatConversationDirectory,
  planLegacyWebChatRecords,
} = require("../src/core/conversation/migrate-legacy-webchat")

test("legacy web segments plus one runtime user become one stable logical message", () => {
  const records = [
    legacyWebUser("message-a", "turn-transport", "first", "2026-07-17T15:35:16.038Z"),
    legacyWebUser("message-b", "turn-transport", "second", "2026-07-17T15:35:16.038Z"),
    legacyWebUser("message-c", "turn-transport", "third", "2026-07-17T15:35:16.038Z"),
    legacyRuntimeUser("runtime-user", "prompt-canonical", "first\n\nsecond\n\nthird", "2026-07-17T15:35:16.600Z"),
  ]

  const result = planLegacyWebChatRecords(records)

  assert.equal(result.logicalMessageCount, 1)
  assert.equal(result.removedRecordCount, 3)
  assert.equal(result.records.length, 1)
  const [canonical] = result.records
  assert.equal(canonical.messageId, "message-a")
  assert.equal(canonical.sourceKey, "web|message|message-a")
  assert.equal(canonical.turnId, "prompt-canonical")
  assert.equal(canonical.meta.displayTurnId, "turn-transport")
  assert.equal(canonical.meta.transportTurnId, "turn-transport")
  assert.equal(canonical.meta.canonicalTurnId, "prompt-canonical")
  assert.deepEqual(
    canonical.meta.bubbleSegments.map((segment) => [segment.segmentId, segment.text]),
    [
      ["message-a", "first"],
      ["message-b", "second"],
      ["message-c", "third"],
    ],
  )
  assert.equal(canonical.messageId.includes("first"), false)
})

test("ambiguous text and time compatibility matches are left untouched", () => {
  const records = [
    legacyWebUser("message-a", "turn-a", "same", "2026-07-17T15:35:16.000Z"),
    legacyRuntimeUser("runtime-a", "prompt-a", "same", "2026-07-17T15:35:17.000Z"),
    legacyRuntimeUser("runtime-b", "prompt-b", "same", "2026-07-17T15:35:18.000Z"),
  ]
  const result = planLegacyWebChatRecords(records)

  assert.equal(result.logicalMessageCount, 0)
  assert.equal(result.removedRecordCount, 0)
  assert.deepEqual(result.records, records)
})

test("canonical bubble-segment records are never treated as migration input", () => {
  const canonical = legacyWebUser(
    "message-canonical",
    "turn-canonical",
    "already canonical",
    "2026-07-17T15:35:16.000Z",
  )
  canonical.meta.bubbleSegments = [{ segmentId: "segment-1", text: "already canonical" }]
  const result = planLegacyWebChatRecords([canonical])

  assert.equal(result.logicalMessageCount, 0)
  assert.equal(result.records[0], canonical)
})

test("directory migration is dry-run by default and write mode creates a backup", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-conversation-migration-"))
  const conversationDir = path.join(stateDir, "conversations")
  fs.mkdirSync(conversationDir, { recursive: true })
  const filePath = path.join(conversationDir, "2026-07-17.jsonl")
  const records = [
    legacyWebUser("message-a", "turn-transport", "first", "2026-07-17T15:35:16.038Z"),
    legacyWebUser("message-b", "turn-transport", "second", "2026-07-17T15:35:16.038Z"),
    legacyRuntimeUser("runtime-user", "prompt-canonical", "first\n\nsecond", "2026-07-17T15:35:16.600Z"),
  ]
  const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  fs.writeFileSync(filePath, original, "utf8")

  const dryRun = migrateLegacyWebChatConversationDirectory({ conversationDir })
  assert.equal(dryRun.mode, "dry-run")
  assert.equal(dryRun.changedFileCount, 1)
  assert.equal(fs.readFileSync(filePath, "utf8"), original)

  const written = migrateLegacyWebChatConversationDirectory({
    conversationDir,
    write: true,
    now: new Date("2026-07-18T00:00:00.000Z"),
  })
  assert.equal(written.mode, "write")
  assert.equal(written.changedFileCount, 1)
  assert.ok(written.backupDir.startsWith(conversationDir))
  assert.equal(
    fs.readFileSync(path.join(written.backupDir, "2026-07-17.jsonl"), "utf8"),
    original,
  )
  const migrated = readJsonl(filePath)
  assert.equal(migrated.length, 1)
  assert.equal(migrated[0].messageId, "message-a")
  assert.equal(migrated[0].meta.bubbleSegments.length, 2)
})

function legacyWebUser(messageId, turnId, text, timestamp) {
  const sourceKey = `web|message|${messageId}`
  return {
    id: `web-user-${messageId}`,
    type: "user",
    timestamp,
    date: "2026-07-17",
    runtimeId: "claudecode",
    threadId: "thread-1",
    turnId,
    workspaceRoot: "D:/study/cyberboss",
    text,
    messageId,
    itemId: "",
    sourceKey,
    meta: {
      messageId,
      attachments: [],
      files: [],
      stickers: [],
      sourceKey,
    },
    source: {
      provider: "web",
      sourceType: "web.message.user",
      sourceLine: 0,
      sourceKey,
      rawId: messageId,
    },
  }
}

function legacyRuntimeUser(id, turnId, text, timestamp) {
  const sourceKey = `claudecode|session.jsonl|42|${id}|user`
  return {
    id,
    type: "user",
    timestamp,
    date: "2026-07-17",
    runtimeId: "claudecode",
    threadId: "thread-1",
    turnId,
    workspaceRoot: "D:\\study\\cyberboss",
    text,
    messageId: "",
    itemId: "",
    sourceKey,
    meta: { attachments: [], files: [], stickers: [], sourceKey },
    source: {
      provider: "claudecode",
      sourceType: "claudecode.realtime.user",
      sourceFile: "session.jsonl",
      sourceLine: 42,
      sourceKey,
      rawId: id,
    },
  }
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

