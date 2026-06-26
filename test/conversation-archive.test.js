const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  ConversationArchive,
  ConversationImporter,
} = require("../src/core/conversation")

const WORKSPACE_ROOT = "D:\\study\\cyberboss"

test("codex import normalizes short operation text, media, prompts, and source lines", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-codex-import-"))
  const sourceFile = path.join(stateDir, "codex-session.jsonl")
  const inboxFile = path.join(stateDir, "inbox", "2026-06-23", "attachment.png")
  fs.mkdirSync(path.dirname(inboxFile), { recursive: true })
  fs.writeFileSync(inboxFile, "png", "utf8")

  const systemAction = [
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Trigger:",
    "codex patrol",
  ].join("\n")
  const sendFileText = `File sent: ${toSlash(inboxFile)}\n${JSON.stringify({ filePath: toSlash(inboxFile) })}`

  writeJsonlFixture(sourceFile, [
    sessionMeta("codex-thread-1"),
    turnContext("turn-codex-1"),
    responseUser("<environment_context>\n  <cwd>D:\\study\\cyberboss</cwd>\n</environment_context>"),
    responseUser(systemAction),
    eventUser(systemAction),
    responseUser("hello codex"),
    eventUser("hello codex"),
    responseFunctionCall("Read", { filePath: "D:\\study\\cyberboss\\src\\core\\app.js" }, "call-read-1"),
    responseFunctionCall("mcp__cyberboss_tools__cyberboss_reminder_create", { message: "drink water" }, "call-reminder-1"),
    responseFunctionCallOutput("call-reminder-1", "Reminder created"),
    responseFunctionCall("mcp__cyberboss_tools__cyberboss_channel_send_file", { filePath: toSlash(inboxFile) }, "call-send-file-1"),
    responseFunctionCallOutput("call-send-file-1", JSON.stringify([{ type: "text", text: sendFileText }])),
    responseAssistant("done codex"),
  ])

  const importer = new ConversationImporter({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
    logger: { warn() {} },
  })

  const result = importer.importFile({
    runtimeId: "codex",
    sourceFile,
    workspaceRoot: WORKSPACE_ROOT,
  })

  assert.equal(result.warnings.length, 0)
  const dayRecords = readConversationDay(stateDir, "2026-06-14")

  assert.equal(dayRecords.filter((record) => record.type === "user" && record.text === "hello codex").length, 1)
  assert.equal(dayRecords.some((record) => record.text.includes("<environment_context>")), false)
  assert.ok(dayRecords.some((record) => (
    record.type === "user"
    && record.text === ""
    && record.meta.visibleAs === "system_compact"
    && record.meta.displayText === "宝宝大王系统巡游"
    && record.source.sourceType === "codex.system_action_mode"
  )))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "Read src/core/app.js"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "[cyberboss_reminder_create] drink water"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "[cyberboss_channel_send_file] attachment.png"))

  const sendFileOperation = dayRecords.find((record) => record.type === "operation" && record.meta.toolName === "cyberboss_channel_send_file")
  assert.equal(sendFileOperation.source.sourceLine, 11)

  const mediaRecord = dayRecords.find((record) => record.type === "assistant" && record.text === "Sent file attachment.png")
  assert.equal(mediaRecord.source.sourceLine, 12)
  assert.equal(mediaRecord.meta.attachments.length, 1)
  assert.equal(mediaRecord.meta.files.length, 0)
  assert.equal(mediaRecord.meta.attachments[0].kind, "image")
  assert.equal(mediaRecord.meta.attachments[0].relativePath, "inbox/2026-06-23/attachment.png")
})

test("claudecode import normalizes tool names, system action mode, and visible media", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-claude-import-"))
  const sourceFile = path.join(stateDir, "claude-session.jsonl")
  const inboxFile = path.join(stateDir, "inbox", "2026-06-23", "attachment.png")
  fs.mkdirSync(path.dirname(inboxFile), { recursive: true })
  fs.writeFileSync(inboxFile, "png", "utf8")

  const systemAction = [
    "[2026-06-17 13:52]",
    "",
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Trigger:",
    "宝宝巡游一下",
  ].join("\n")
  const sendFileText = `File sent: ${toSlash(inboxFile)}\n${JSON.stringify({ filePath: toSlash(inboxFile) })}`

  writeJsonlFixture(sourceFile, [
    claudeUser("claude-session-1", "prompt-user-1", "user-1", "hello claude"),
    claudeUser("claude-session-1", "prompt-system-1", "user-system-1", systemAction),
    claudeUser("claude-session-1", "prompt-hidden-1", "user-hidden-1", "WECHAT SESSION INSTRUCTIONS\nCurrent user message:\nshould drop"),
    claudeAssistant("claude-session-1", "assistant-1", "user-1", [
      { type: "thinking", thinking: "plan first" },
      { type: "tool_use", id: "tool-file-1", name: "mcp__cyberboss_tools__cyberboss_channel_send_file", input: { filePath: toSlash(inboxFile) } },
      { type: "text", text: "done claude" },
    ]),
    claudeToolResult("claude-session-1", "tool-result-1", "tool-file-1", sendFileText),
    claudeAssistant("claude-session-1", "assistant-2", "user-1", [
      { type: "tool_use", id: "tool-reminder-1", name: "mcp__cyberboss_tools__cyberboss_reminder_create", input: { text: "drink water" } },
    ]),
    claudeToolResult("claude-session-1", "tool-result-2", "tool-reminder-1", "Reminder created"),
  ])

  const importer = new ConversationImporter({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
    logger: { warn() {} },
  })

  importer.importFile({
    runtimeId: "claudecode",
    sourceFile,
    workspaceRoot: WORKSPACE_ROOT,
  })

  const dayRecords = readConversationDay(stateDir, "2026-06-17")
  assert.equal(dayRecords.some((record) => record.text.includes("WECHAT SESSION INSTRUCTIONS")), false)
  assert.ok(dayRecords.some((record) => (
    record.type === "user"
    && record.text === ""
    && record.meta.visibleAs === "system_compact"
    && record.source.sourceType === "claudecode.system_action_mode"
  )))
  assert.ok(dayRecords.some((record) => record.type === "thinking" && record.text === "plan first"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "[cyberboss_channel_send_file] attachment.png"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "[cyberboss_reminder_create] drink water"))

  const sendFileOperation = dayRecords.find((record) => record.type === "operation" && record.text === "[cyberboss_channel_send_file] attachment.png")
  assert.equal(sendFileOperation.meta.toolName, "cyberboss_channel_send_file")
  assert.equal(sendFileOperation.meta.toolName.startsWith("mcp__"), false)

  const mediaRecord = dayRecords.find((record) => record.type === "assistant" && record.text === "Sent file attachment.png")
  assert.equal(mediaRecord.meta.attachments.length, 1)
  assert.equal(mediaRecord.meta.attachments[0].relativePath, "inbox/2026-06-23/attachment.png")
})

test("codex realtime tails raw session lines, uses real source lines, and dedupes inbound user messages", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-codex-rt-"))
  const sourceFile = path.join(stateDir, "codex-realtime.jsonl")
  const inboxFile = path.join(stateDir, "inbox", "2026-06-23", "attachment.png")
  fs.mkdirSync(path.dirname(inboxFile), { recursive: true })
  fs.writeFileSync(inboxFile, "png", "utf8")

  writeJsonlFixture(sourceFile, [
    sessionMeta("codex-rt-1", "2026-06-18T01:00:00.000Z"),
    turnContext("turn-rt-1", "2026-06-18T01:00:00.100Z"),
    responseUser("hello realtime", "2026-06-18T01:00:00.200Z"),
    responseFunctionCall("mcp__cyberboss_tools__cyberboss_channel_send_file", { filePath: toSlash(inboxFile) }, "call-send-file-rt-1", "2026-06-18T01:00:00.300Z"),
    responseFunctionCallOutput("call-send-file-rt-1", `File sent: ${toSlash(inboxFile)}\n${JSON.stringify({ filePath: toSlash(inboxFile) })}`, "2026-06-18T01:00:00.400Z"),
    responseAssistant("codex realtime reply", "2026-06-18T01:00:00.500Z"),
  ])

  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
  })

  archive.recordInboundMessage({
    provider: "weixin",
    messageId: "wx-1",
    text: "hello realtime",
    receivedAt: "2026-06-18T01:00:00.000Z",
  }, {
    runtimeId: "codex",
    threadId: "codex-rt-1",
    workspaceRoot: WORKSPACE_ROOT,
  })

  archive.registerRealtimeSource({
    runtimeId: "codex",
    threadId: "codex-rt-1",
    workspaceRoot: WORKSPACE_ROOT,
    sourceFile,
  })

  archive.recordRuntimeRaw({
    runtimeId: "codex",
    raw: {
      method: "turn/started",
      params: {
        threadId: "codex-rt-1",
        turn: { id: "turn-rt-1" },
      },
    },
    mappedEvent: {
      payload: {
        threadId: "codex-rt-1",
        turnId: "turn-rt-1",
      },
    },
    workspaceRoot: WORKSPACE_ROOT,
  })

  archive.recordRuntimeRaw({
    runtimeId: "codex",
    raw: {
      method: "turn/started",
      params: {
        threadId: "codex-rt-1",
        turn: { id: "turn-rt-1" },
      },
    },
    mappedEvent: {
      payload: {
        threadId: "codex-rt-1",
        turnId: "turn-rt-1",
      },
    },
    workspaceRoot: WORKSPACE_ROOT,
  })

  const dayRecords = readConversationDay(stateDir, "2026-06-18")
  assert.equal(dayRecords.filter((record) => record.type === "user" && record.text === "hello realtime").length, 1)
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "[cyberboss_channel_send_file] attachment.png"))
  assert.ok(dayRecords.some((record) => record.type === "assistant" && record.text === "codex realtime reply"))

  const operation = dayRecords.find((record) => record.type === "operation" && record.meta.toolName === "cyberboss_channel_send_file")
  const media = dayRecords.find((record) => record.type === "assistant" && record.text === "Sent file attachment.png")
  const reply = dayRecords.find((record) => record.type === "assistant" && record.text === "codex realtime reply")

  assert.equal(operation.source.sourceLine, 4)
  assert.equal(media.source.sourceLine, 5)
  assert.equal(reply.source.sourceLine, 6)
})

test("claudecode realtime tails transcript once and merges tool_use plus tool_result without duplicates", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-claude-rt-"))
  const sourceFile = path.join(stateDir, "claude-realtime.jsonl")
  const inboxFile = path.join(stateDir, "inbox", "2026-06-23", "attachment.png")
  fs.mkdirSync(path.dirname(inboxFile), { recursive: true })
  fs.writeFileSync(inboxFile, "png", "utf8")

  writeJsonlFixture(sourceFile, [
    claudeUser("claude-rt-1", "prompt-1", "user-1", "plain claude realtime user", "2026-06-18T01:00:00.100Z"),
    claudeAssistant("claude-rt-1", "assistant-1", "user-1", [
      { type: "thinking", thinking: "think once" },
      { type: "tool_use", id: "tool-file-1", name: "mcp__cyberboss_tools__cyberboss_channel_send_file", input: { filePath: toSlash(inboxFile) } },
      { type: "text", text: "claude realtime reply" },
    ], "2026-06-18T01:00:00.200Z"),
    claudeToolResult("claude-rt-1", "tool-result-1", "tool-file-1", `File sent: ${toSlash(inboxFile)}\n${JSON.stringify({ filePath: toSlash(inboxFile) })}`, "2026-06-18T01:00:00.300Z"),
  ])

  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
  })

  archive.registerRealtimeSource({
    runtimeId: "claudecode",
    threadId: "claude-rt-1",
    workspaceRoot: WORKSPACE_ROOT,
    sourceFile,
  })

  const runtimeTrigger = {
    runtimeId: "claudecode",
    raw: {
      type: "assistant.text",
      sessionId: "claude-rt-1",
    },
    mappedEvent: {
      payload: {
        threadId: "claude-rt-1",
      },
    },
    workspaceRoot: WORKSPACE_ROOT,
  }

  archive.recordRuntimeRaw(runtimeTrigger)
  archive.recordRuntimeRaw(runtimeTrigger)

  const dayRecords = readConversationDay(stateDir, "2026-06-18")
  assert.equal(dayRecords.filter((record) => record.type === "user" && record.text === "plain claude realtime user").length, 1)
  assert.equal(dayRecords.filter((record) => record.type === "thinking" && record.text === "think once").length, 1)
  assert.equal(dayRecords.filter((record) => record.type === "assistant" && record.text === "claude realtime reply").length, 1)
  assert.equal(dayRecords.filter((record) => record.type === "operation" && record.text === "[cyberboss_channel_send_file] attachment.png").length, 1)
  assert.equal(dayRecords.filter((record) => record.type === "assistant" && record.text === "Sent file attachment.png").length, 1)

  const operation = dayRecords.find((record) => record.type === "operation" && record.text === "[cyberboss_channel_send_file] attachment.png")
  assert.equal(operation.meta.toolName, "cyberboss_channel_send_file")
  assert.equal(operation.source.sourceLine, 2)

  const visible = dayRecords.find((record) => record.type === "assistant" && record.text === "Sent file attachment.png")
  assert.equal(visible.source.sourceLine, 3)
})

test("realtime and import produce matching source keys and visible media for the same codex raw lines", () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-parity-"))
  const sourceFile = path.join(sourceDir, "codex-parity.jsonl")
  const inboxFile = path.join(sourceDir, "inbox", "2026-06-23", "attachment.png")
  fs.mkdirSync(path.dirname(inboxFile), { recursive: true })
  fs.writeFileSync(inboxFile, "png", "utf8")

  writeJsonlFixture(sourceFile, [
    sessionMeta("codex-parity-1"),
    turnContext("turn-parity-1"),
    responseFunctionCall("mcp__cyberboss_tools__cyberboss_channel_send_file", { filePath: toSlash(inboxFile) }, "call-send-file-1"),
    responseFunctionCallOutput("call-send-file-1", `File sent: ${toSlash(inboxFile)}\n${JSON.stringify({ filePath: toSlash(inboxFile) })}`),
    responseAssistant("done parity"),
  ])

  const importStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-import-parity-"))
  const realtimeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-realtime-parity-"))

  const importer = new ConversationImporter({
    config: {
      conversationDir: path.join(importStateDir, "conversations"),
      stateDir: sourceDir,
    },
    logger: { warn() {} },
  })
  importer.importFile({
    runtimeId: "codex",
    sourceFile,
    workspaceRoot: WORKSPACE_ROOT,
  })

  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(realtimeStateDir, "conversations"),
      stateDir: sourceDir,
    },
  })

  const lines = fs.readFileSync(sourceFile, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))

  lines.forEach((raw, index) => {
    archive.ingestRealtimeSessionLine({
      runtimeId: "codex",
      raw,
      sourceFile,
      sourceLine: index + 1,
      workspaceRoot: WORKSPACE_ROOT,
    })
  })

  const imported = simplifyRecords(readConversationDay(importStateDir, "2026-06-14"))
  const realtime = simplifyRecords(readConversationDay(realtimeStateDir, "2026-06-14"))
  assert.deepEqual(realtime, imported)
})

function sessionMeta(threadId, timestamp = "2026-06-14T08:23:11.319Z") {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id: threadId,
      cwd: WORKSPACE_ROOT,
    },
  }
}

function turnContext(turnId, timestamp = "2026-06-14T08:23:11.400Z") {
  return {
    timestamp,
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd: WORKSPACE_ROOT,
      workspace_roots: [WORKSPACE_ROOT],
    },
  }
}

function responseUser(text, timestamp = "2026-06-14T08:23:11.500Z") {
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

function responseAssistant(text, timestamp = "2026-06-14T08:23:12.500Z") {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  }
}

function eventUser(message, timestamp = "2026-06-14T08:23:11.510Z") {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "user_message",
      message,
    },
  }
}

function responseFunctionCall(name, argumentsObject, callId, timestamp = "2026-06-14T08:23:12.000Z") {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name,
      arguments: JSON.stringify(argumentsObject),
      call_id: callId,
    },
  }
}

function responseFunctionCallOutput(callId, output, timestamp = "2026-06-14T08:23:12.100Z") {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output,
    },
  }
}

function claudeUser(sessionId, promptId, uuid, content, timestamp = "2026-06-17T05:51:38.091Z") {
  return {
    type: "user",
    timestamp,
    sessionId,
    cwd: WORKSPACE_ROOT,
    promptId,
    uuid,
    message: {
      role: "user",
      content,
    },
  }
}

function claudeAssistant(sessionId, uuid, parentUuid, content, timestamp = "2026-06-17T05:51:39.000Z") {
  return {
    type: "assistant",
    timestamp,
    sessionId,
    cwd: WORKSPACE_ROOT,
    uuid,
    parentUuid,
    message: {
      id: `msg-${uuid}`,
      type: "message",
      role: "assistant",
      content,
    },
  }
}

function claudeToolResult(sessionId, uuid, toolUseId, content, timestamp = "2026-06-17T05:51:39.500Z") {
  return {
    type: "user",
    timestamp,
    sessionId,
    cwd: WORKSPACE_ROOT,
    uuid,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content, is_error: false },
      ],
    },
  }
}

function writeJsonlFixture(filePath, items) {
  const lines = items.map((item) => JSON.stringify(item))
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8")
}

function readConversationDay(stateDir, date) {
  const filePath = path.join(stateDir, "conversations", `${date}.jsonl`)
  const raw = fs.readFileSync(filePath, "utf8")
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function simplifyRecords(records) {
  return records.map((record) => ({
    type: record.type,
    text: record.text,
    sourceKey: record.source.sourceKey,
    sourceLine: record.source.sourceLine,
    toolName: record.meta.toolName || "",
    visibleAs: record.meta.visibleAs || "",
    displayText: record.meta.displayText || "",
    attachments: record.meta.attachments,
    files: record.meta.files,
    stickers: record.meta.stickers,
  }))
}

function toSlash(value) {
  return String(value || "").replace(/\\/g, "/")
}
