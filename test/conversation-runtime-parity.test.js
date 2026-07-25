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

test("codex realtime and import expose the inner MCP tool instead of its exec wrapper", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codex-mcp-"))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const sourceFile = path.join(rootDir, "codex-mcp.jsonl")
  const rawRecords = [
    codexSession("thread-mcp"),
    codexTurn("turn-mcp", "2026-07-25T08:40:00.010Z"),
    codexCustomToolCall({
      callId: "call-wrapper",
      input: "const result = await tools.mcp__cloud_music__cloud_music_play({id: \"123\"})",
      timestamp: "2026-07-25T08:40:01.000Z",
    }),
    codexMcpToolCallEnd({
      callId: "mcp-call-1",
      server: "cloud_music",
      tool: "cloud_music_play",
      args: { id: "123", type: "song" },
      result: { ok: true },
      timestamp: "2026-07-25T08:40:01.010Z",
    }),
    codexCustomToolCallOutput("call-wrapper", "completed", "2026-07-25T08:40:01.020Z"),
    codexTaskComplete("2026-07-25T08:40:01.030Z"),
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
    const operations = records.filter((record) => record.type === "operation")
    assert.deepEqual(operations.map((record) => record.meta.toolName), ["cloud_music_play"])
  }
})

test("codex realtime and import preserve each MCP operation and its visible assistant media", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codex-mcp-media-"))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const sourceFile = path.join(rootDir, "codex-mcp-media.jsonl")
  const imagePath = `${WORKSPACE_ROOT}/tmp/fixture.png`
  const filePath = `${WORKSPACE_ROOT}/tmp/fixture.txt`
  const stickerPath = `${WORKSPACE_ROOT}/stickers/fixture.gif`
  const rawRecords = [
    codexSession("thread-mcp-media"),
    codexTurn("turn-mcp-media", "2026-07-25T08:50:00.010Z"),
    codexCustomToolCall({
      callId: "call-media-wrapper",
      input: [
        "await tools.mcp__cyberboss_tools__cyberboss_channel_send_file({filePath: imagePath})",
        "await tools.mcp__cyberboss_tools__cyberboss_channel_send_file({filePath})",
        "await tools.mcp__cyberboss_tools__cyberboss_sticker_send({stickerId})",
      ].join("\n"),
      timestamp: "2026-07-25T08:50:01.000Z",
    }),
    codexMcpToolCallEnd({
      callId: "mcp-image",
      server: "cyberboss_tools",
      tool: "cyberboss_channel_send_file",
      args: { filePath: imagePath },
      result: { path: imagePath },
      timestamp: "2026-07-25T08:50:01.010Z",
    }),
    codexMcpToolCallEnd({
      callId: "mcp-file",
      server: "cyberboss_tools",
      tool: "cyberboss_channel_send_file",
      args: { filePath },
      result: { path: filePath },
      timestamp: "2026-07-25T08:50:01.020Z",
    }),
    codexMcpToolCallEnd({
      callId: "mcp-sticker",
      server: "cyberboss_tools",
      tool: "cyberboss_sticker_send",
      args: { stickerId: "sticker-fixture" },
      result: { path: stickerPath, stickerId: "sticker-fixture" },
      timestamp: "2026-07-25T08:50:01.030Z",
    }),
    codexCustomToolCallOutput("call-media-wrapper", "completed", "2026-07-25T08:50:01.040Z"),
    codexTaskComplete("2026-07-25T08:50:01.050Z"),
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
    assert.deepEqual(
      records.filter((record) => record.type === "operation").map((record) => record.meta.toolName),
      [
        "cyberboss_channel_send_file",
        "cyberboss_channel_send_file",
        "cyberboss_sticker_send",
      ],
    )
    const visible = records.filter((record) => record.type === "assistant")
    assert.equal(visible.length, 3)
    assert.deepEqual(pickMedia(visible[0].meta.attachments[0]), {
      fileName: "fixture.png",
      kind: "image",
      isImage: true,
      path: imagePath,
      relativePath: "tmp/fixture.png",
      stickerId: "",
    })
    assert.deepEqual(pickMedia(visible[1].meta.files[0]), {
      fileName: "fixture.txt",
      kind: "file",
      isImage: false,
      path: filePath,
      relativePath: "tmp/fixture.txt",
      stickerId: "",
    })
    assert.deepEqual(pickMedia(visible[2].meta.stickers[0]), {
      fileName: "fixture.gif",
      kind: "sticker",
      isImage: true,
      path: stickerPath,
      relativePath: "stickers/fixture.gif",
      stickerId: "sticker-fixture",
    })
    assert.equal(visible[2].meta.attachments.length, 1)
  }
})

test("codex realtime and import keep an ordinary exec operation", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codex-exec-"))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const sourceFile = path.join(rootDir, "codex-exec.jsonl")
  const rawRecords = [
    codexSession("thread-exec"),
    codexTurn("turn-exec", "2026-07-25T08:55:00.010Z"),
    codexCustomToolCall({
      callId: "call-exec",
      input: "Get-ChildItem -Path .",
      timestamp: "2026-07-25T08:55:01.000Z",
    }),
    codexCustomToolCallOutput("call-exec", "completed", "2026-07-25T08:55:01.010Z"),
    codexTaskComplete("2026-07-25T08:55:01.020Z"),
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
    assert.deepEqual(
      records.filter((record) => record.type === "operation").map((record) => record.meta.toolName),
      ["exec"],
    )
  }
})

test("claudecode realtime and import preserve a nested quoted envelope", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-quote-"))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const sourceFile = path.join(rootDir, "claude-quote.jsonl")
  const rawRecords = [
    claudeUser({
      sessionId: "thread-claude-quote",
      promptId: "turn-claude-quote",
      uuid: "user-claude-quote",
      text: "[Quoted: [cloud_music_play] 287248]\n好听哦",
      timestamp: "2026-07-25T09:00:00.000Z",
    }),
  ]
  writeJsonl(sourceFile, rawRecords)

  const { realtime, imported } = runBothModes({
    rootDir,
    runtimeId: "claudecode",
    sourceFile,
    rawRecords,
    date: "2026-07-25",
  })

  for (const records of [realtime, imported]) {
    assert.equal(records.length, 1)
    assert.equal(records[0].text, "好听哦")
    assert.equal(records[0].meta.quote, "[cloud_music_play] 287248")
  }
})

test("merged web inbound preserves a nested quoted envelope", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-web-quote-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const archive = createArchive(stateDir)
  t.after(() => archive.close())

  archive.recordMergedWebInbound({
    provider: "web",
    senderId: "user-web-quote",
    requestId: "request-web-quote",
    messageId: "message-web-quote",
    logicalTurnId: "web:request-web-quote",
    originalText: "[Quoted: [表情包]]\n萌~",
    receivedAt: "2026-07-25T09:05:00.000Z",
    attachments: [],
  }, {
    runtimeId: "codex",
    threadId: "thread-web-quote",
    turnId: "turn-web-quote",
    workspaceRoot: WORKSPACE_ROOT,
  })

  const [record] = readDay(stateDir, "2026-07-25")
  assert.equal(record.text, "萌~")
  assert.equal(record.meta.quote, "[表情包]")
})

test("codex realtime and import hide only the composite bootstrap context", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codex-bootstrap-"))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const sourceFile = path.join(rootDir, "codex-bootstrap.jsonl")
  const bootstrap = [
    "<recommended_plugins>",
    "fixture plugin metadata",
    "</recommended_plugins>",
    "# AGENTS.md instructions for D:\\study\\cyberboss",
    "<environment_context>",
    "<cwd>D:\\study\\cyberboss</cwd>",
    "</environment_context>",
  ].join("\n")
  const ordinaryDiscussion = "我想讨论 AGENTS.md 与 <environment_context> 的职责区别"
  const rawRecords = [
    codexSession("thread-bootstrap"),
    codexTurn("turn-bootstrap", "2026-07-25T09:10:00.010Z"),
    codexUser(bootstrap, "2026-07-25T09:10:00.020Z"),
    codexTurn("turn-ordinary", "2026-07-25T09:11:00.010Z"),
    codexUser(ordinaryDiscussion, "2026-07-25T09:11:00.020Z"),
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
    const users = records.filter((record) => record.type === "user")
    assert.equal(users.length, 1)
    assert.equal(users[0].text, ordinaryDiscussion)
  }
})

test("claudecode realtime and import leave composite context text unchanged", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-bootstrap-"))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const sourceFile = path.join(rootDir, "claude-bootstrap.jsonl")
  const text = [
    "<recommended_plugins>",
    "fixture plugin metadata",
    "</recommended_plugins>",
    "# AGENTS.md instructions for a fixture",
    "<environment_context>",
    "<cwd>fixture</cwd>",
    "</environment_context>",
  ].join("\n")
  const rawRecords = [
    claudeUser({
      sessionId: "thread-claude-bootstrap",
      promptId: "turn-claude-bootstrap",
      uuid: "user-claude-bootstrap",
      text,
      timestamp: "2026-07-25T09:15:00.000Z",
    }),
  ]
  writeJsonl(sourceFile, rawRecords)

  const { realtime, imported } = runBothModes({
    rootDir,
    runtimeId: "claudecode",
    sourceFile,
    rawRecords,
    date: "2026-07-25",
  })

  for (const records of [realtime, imported]) {
    assert.equal(records.length, 1)
    assert.equal(records[0].text, text)
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

function codexCustomToolCall({ callId, input, timestamp }) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: callId,
      input,
    },
  }
}

function codexCustomToolCallOutput(callId, output, timestamp) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output,
    },
  }
}

function codexMcpToolCallEnd({ callId, server, tool, args, result, timestamp }) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_end",
      call_id: callId,
      invocation: {
        server,
        tool,
        arguments: args,
      },
      result,
    },
  }
}

function claudeUser({ sessionId, promptId, uuid, text, timestamp }) {
  return {
    type: "user",
    sessionId,
    promptId,
    uuid,
    cwd: WORKSPACE_ROOT,
    timestamp,
    message: {
      role: "user",
      content: text,
    },
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

function pickMedia(item = {}) {
  return {
    fileName: item.fileName || "",
    kind: item.kind || "",
    isImage: Boolean(item.isImage),
    path: item.path || "",
    relativePath: item.relativePath || "",
    stickerId: item.stickerId || "",
  }
}
