const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
  ConversationArchive,
  ConversationImporter,
} = require("../src/custom/xiaoye/conversation")

const FIXTURE_ROOT = path.join(__dirname, "fixtures", "conversation")
const WORKSPACE_ROOT = "D:/study/cyberboss"
const VISIBLE_FIELDS = [
  "type",
  "runtimeId",
  "threadId",
  "turnId",
  "itemId",
  "messageId",
  "text",
  "quote",
  "toolName",
  "operationKind",
  "attachments",
  "files",
  "stickers",
  "visibleAs",
  "displayText",
]

const RUNTIME_FIXTURES = {
  codex: [
    "codex/assistant-identity.jsonl",
    "codex/mcp-tools-and-media.jsonl",
    "codex/bootstrap-context.jsonl",
    "codex/inbound-media.jsonl",
  ],
  claudecode: [
    "claudecode/inbound-media.jsonl",
    "claudecode/nested-quote.jsonl",
    "claudecode/tools-and-media.jsonl",
  ],
}

for (const runtimeId of Object.keys(RUNTIME_FIXTURES)) {
  test(`${runtimeId} realtime and import share the visible conversation matrix`, (t) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `cyberboss-${runtimeId}-matrix-`))
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))

    const { realtime, realtimeBeforeReplay, imported } = runFixtureModes({
      rootDir,
      runtimeId,
      fixtureFiles: RUNTIME_FIXTURES[runtimeId],
    })
    assert.deepEqual(
      imported.map(pickVisibleSemantics),
      realtime.map(pickVisibleSemantics),
    )
    assert.deepEqual(
      realtime.map(pickVisibleSemantics),
      realtimeBeforeReplay.map(pickVisibleSemantics),
    )
    const realtimeVisible = realtime.map(pickVisibleSemantics).sort(compareStable)
    const importedVisible = imported.map(pickVisibleSemantics).sort(compareStable)

    assert.deepEqual(importedVisible, realtimeVisible)
    assertMatrixCoverage(runtimeId, realtimeVisible)
  })
}

function runFixtureModes({ rootDir, runtimeId, fixtureFiles }) {
  const realtimeDir = path.join(rootDir, "realtime")
  const importDir = path.join(rootDir, "import")
  const sourceFile = path.join(rootDir, `${runtimeId}-matrix-source.jsonl`)
  const rawRecords = fixtureFiles.flatMap(readFixtureRecords)
  fs.writeFileSync(
    sourceFile,
    `${rawRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  )

  const realtimeArchive = createArchive(realtimeDir)
  seedWebInboundFixture(realtimeArchive, runtimeId)
  rawRecords.forEach((raw, index) => {
    realtimeArchive.ingestRealtimeSessionLine({
      runtimeId,
      raw,
      sourceFile,
      sourceLine: index + 1,
      workspaceRoot: WORKSPACE_ROOT,
    })
  })
  const realtimeBeforeReplay = readConversationDays(realtimeDir)
  rawRecords.forEach((raw, index) => {
    realtimeArchive.ingestRealtimeSessionLine({
      runtimeId,
      raw,
      sourceFile,
      sourceLine: index + 1,
      workspaceRoot: WORKSPACE_ROOT,
    })
  })
  realtimeArchive.close()

  const importArchive = createArchive(importDir)
  seedWebInboundFixture(importArchive, runtimeId)
  importArchive.close()
  const importer = new ConversationImporter({
    config: {
      stateDir: importDir,
      conversationDir: path.join(importDir, "conversations"),
    },
    logger: { warn() {} },
  })
  importer.importFile({ runtimeId, sourceFile, workspaceRoot: WORKSPACE_ROOT })

  return {
    realtime: readConversationDays(realtimeDir),
    realtimeBeforeReplay,
    imported: readConversationDays(importDir),
  }
}

function seedWebInboundFixture(archive, runtimeId) {
  const context = {
    runtimeId,
    threadId: `fixture-${runtimeId}-web`,
    workspaceRoot: WORKSPACE_ROOT,
  }
  archive.recordMergedWebInbound({
    provider: "web",
    senderId: "fixture-user",
    requestId: `fixture-${runtimeId}-web-image`,
    messageId: `fixture-${runtimeId}-web-image`,
    logicalTurnId: `web:fixture-${runtimeId}-web-image`,
    originalText: "带图片的脱敏 WebChat 文字",
    receivedAt: "2026-07-25T12:00:00.000Z",
    attachments: [{
      kind: "image",
      fileName: "fixture-web.png",
      path: `${WORKSPACE_ROOT}/inbox/fixture-web.png`,
      isImage: true,
    }],
  }, {
    ...context,
    turnId: `fixture-${runtimeId}-web-image-turn`,
  })
  archive.recordMergedWebInbound({
    provider: "web",
    senderId: "fixture-user",
    requestId: `fixture-${runtimeId}-web-file`,
    messageId: `fixture-${runtimeId}-web-file`,
    logicalTurnId: `web:fixture-${runtimeId}-web-file`,
    originalText: "",
    receivedAt: "2026-07-25T12:00:01.000Z",
    attachments: [{
      kind: "file",
      fileName: "fixture-web.txt",
      path: `${WORKSPACE_ROOT}/inbox/fixture-web.txt`,
      contentType: "text/plain",
      isImage: false,
    }],
  }, {
    ...context,
    turnId: `fixture-${runtimeId}-web-file-turn`,
  })
}

function assertMatrixCoverage(runtimeId, records) {
  const users = records.filter((record) => record.type === "user")
  const assistants = records.filter((record) => record.type === "assistant")
  const operations = records.filter((record) => record.type === "operation")
  const toolNames = operations.map((record) => record.toolName)

  assert.ok(users.some((record) => record.text.includes("普通脱敏用户文字")))
  assert.ok(users.some((record) => record.attachments.some((item) => item.kind === "image")))
  assert.ok(users.some((record) => record.files.some((item) => item.kind === "file")))
  assert.ok(users.some((record) => record.messageId.includes("web-image")))
  assert.ok(users.some((record) => record.messageId.includes("web-file")))
  assert.ok(assistants.some((record) => record.attachments.some((item) => item.kind === "image")))
  assert.ok(assistants.some((record) => record.files.some((item) => item.kind === "file")))
  assert.ok(assistants.some((record) => record.stickers.some((item) => item.kind === "sticker")))
  assert.ok(toolNames.includes("cloud_music_play"))
  assert.ok(toolNames.includes("cyberboss_channel_send_file"))
  assert.ok(assistants.filter((record) => record.text.includes("脱敏回复")).length >= 2)

  if (runtimeId === "codex") {
    assert.ok(toolNames.includes("shell_command"))
    assert.equal(toolNames.includes("exec"), false)
    assert.ok(records.every((record) => !record.text.includes("[exec]")))
    assert.ok(records.every((record) => !record.text.includes("<recommended_plugins>")))
    assert.deepEqual(
      assistants
        .filter((record) => record.itemId.startsWith("fixture-msg-assistant-"))
        .map((record) => record.itemId)
        .sort(),
      ["fixture-msg-assistant-1", "fixture-msg-assistant-2"],
    )
  } else {
    assert.ok(users.some((record) => (
      record.quote === "[cloud_music_play] fixture-song"
      && record.text === "脱敏引用回复"
    )))
  }
}

function pickVisibleSemantics(record = {}) {
  const meta = record.meta && typeof record.meta === "object" ? record.meta : {}
  const values = {
    type: record.type || "",
    runtimeId: record.runtimeId || "",
    threadId: record.threadId || "",
    turnId: record.turnId || "",
    itemId: record.itemId || meta.itemId || "",
    messageId: record.messageId || meta.messageId || "",
    text: record.text || "",
    quote: record.quote || meta.quote || "",
    toolName: record.toolName || meta.toolName || "",
    operationKind: record.operationKind || meta.operationKind || "",
    attachments: normalizeMedia(record.attachments || meta.attachments),
    files: normalizeMedia(record.files || meta.files),
    stickers: normalizeMedia(record.stickers || meta.stickers),
    visibleAs: record.visibleAs || meta.visibleAs || "",
    displayText: record.displayText || meta.displayText || "",
  }
  assert.deepEqual(Object.keys(values), VISIBLE_FIELDS)
  return values
}

function normalizeMedia(items) {
  return (Array.isArray(items) ? items : []).map(stableObject)
}

function readFixtureRecords(relativePath) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, relativePath), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function readConversationDays(stateDir) {
  const conversationDir = path.join(stateDir, "conversations")
  return fs.readdirSync(conversationDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => fs.readFileSync(path.join(conversationDir, name), "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line)))
}

function createArchive(stateDir) {
  return new ConversationArchive({
    config: {
      stateDir,
      conversationDir: path.join(stateDir, "conversations"),
    },
  })
}

function compareStable(left, right) {
  return JSON.stringify(stableObject(left)).localeCompare(JSON.stringify(stableObject(right)))
}

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableObject)
  }
  if (!value || typeof value !== "object") {
    return value
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableObject(value[key])]),
  )
}
