const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  ConversationArchive,
  ConversationImporter,
  ConversationWriter,
} = require("../src/custom/xiaoye/conversation")
const { ConversationSourceLineResolver } = require("../src/custom/xiaoye/conversation/source-line-resolver")

const WORKSPACE_ROOT = "D:\\study\\cyberboss"

test("merged web inbound writes one canonical logical record with bubble segments", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-web-identity-"))
  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
  })

  const result = archive.recordMergedWebInbound({
    provider: "web",
    senderId: "user-1",
    requestId: "request-web-1",
    messageId: "message-web-1",
    logicalTurnId: "web:request-web-1",
    originalText: "first\n\nsecond",
    receivedAt: "2026-07-17T00:00:00.000Z",
    attachments: [],
    bubbleSegments: [
      { segmentId: "segment-web-1", text: "first" },
      { segmentId: "segment-web-2", text: "second" },
    ],
  }, {
    runtimeId: "claudecode",
    threadId: "thread-web",
    turnId: "turn-web",
    workspaceRoot: WORKSPACE_ROOT,
  })

  assert.equal(result.writtenCount, 1)
  const records = readConversationDay(stateDir, "2026-07-17")
  assert.equal(records.length, 1)
  assert.equal(records[0].messageId, "message-web-1")
  assert.equal(records[0].sourceKey, "web|message|message-web-1")
  assert.equal(records[0].meta.requestId, "request-web-1")
  assert.equal(records[0].meta.logicalTurnId, "web:request-web-1")
  assert.deepEqual(
    records[0].meta.bubbleSegments.map((segment) => segment.segmentId),
    ["segment-web-1", "segment-web-2"],
  )
  assert.ok(records.every((record) => record.threadId === "thread-web" && record.turnId === "turn-web"))
})

test("raw Claude user correlates into the existing web user without a second record", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-web-correlation-"))
  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
  })
  const prepared = {
    provider: "web",
    senderId: "user-1",
    requestId: "request-correlation-1",
    messageId: "message-correlation-1",
    logicalTurnId: "web:request-correlation-1",
    originalText: "first\n\nsecond\n\nthird",
    receivedAt: "2026-07-18T00:00:00.000Z",
    attachments: [],
    bubbleSegments: [
      { segmentId: "segment-a", text: "first" },
      { segmentId: "segment-b", text: "second" },
      { segmentId: "segment-c", text: "third" },
    ],
  }
  archive.recordMergedWebInbound(prepared, {
    runtimeId: "claudecode",
    threadId: "thread-correlation-1",
    turnId: "transport-correlation-1",
    workspaceRoot: WORKSPACE_ROOT,
  })

  const rawUser = claudeUser(
    "thread-correlation-1",
    "prompt-correlation-1",
    "user-correlation-1",
    "[2026-07-18 08:00]\n\nfirst\n\nsecond\n\nthird",
    "2026-07-18T00:00:01.000Z",
  )
  archive.ingestRealtimeSessionLine({
    runtimeId: "claudecode",
    raw: rawUser,
    sourceFile: path.join(stateDir, "claude-correlation.jsonl"),
    sourceLine: 1,
    workspaceRoot: WORKSPACE_ROOT,
  })

  archive.ingestRealtimeSessionLine({
    runtimeId: "claudecode",
    raw: claudeAssistant(
      "thread-correlation-1",
      "assistant-correlation-1",
      "user-correlation-1",
      [
        { type: "thinking", thinking: "stable thought" },
        { type: "text", text: "stable answer" },
      ],
      "2026-07-18T00:00:02.000Z",
    ),
    sourceFile: path.join(stateDir, "claude-correlation.jsonl"),
    sourceLine: 2,
    workspaceRoot: WORKSPACE_ROOT,
  })
  archive.ingestRealtimeSessionLine({
    runtimeId: "claudecode",
    raw: rawUser,
    sourceFile: path.join(stateDir, "claude-correlation.jsonl"),
    sourceLine: 1,
    workspaceRoot: WORKSPACE_ROOT,
  })

  const records = readConversationDay(stateDir, "2026-07-18")
  const users = records.filter((record) => record.type === "user")
  assert.equal(users.length, 1)
  assert.equal(users[0].source.provider, "web")
  assert.equal(users[0].sourceKey, "web|message|message-correlation-1")
  assert.equal(users[0].messageId, "message-correlation-1")
  assert.equal(users[0].turnId, "prompt-correlation-1")
  assert.equal(users[0].meta.logicalTurnId, "web:request-correlation-1")
  assert.equal(users[0].meta.displayTurnId, "web:request-correlation-1")
  assert.equal(users[0].meta.transportTurnId, "transport-correlation-1")
  assert.equal(users[0].meta.canonicalTurnId, "prompt-correlation-1")
  assert.equal(users[0].meta.bubbleSegments.length, 3)
  const turnRecords = records.filter((record) => (
    record.type === "thinking" || record.type === "assistant"
  ))
  assert.equal(turnRecords.length, 2)
  for (const record of turnRecords) {
    assert.equal(record.meta.requestId, "request-correlation-1")
    assert.equal(record.meta.logicalTurnId, "web:request-correlation-1")
    assert.equal(record.meta.displayTurnId, "web:request-correlation-1")
    assert.equal(record.meta.transportTurnId, "transport-correlation-1")
    assert.equal(record.meta.canonicalTurnId, "prompt-correlation-1")
  }
})

test("codex import keeps approvals internal while preserving operations, media, prompts, and source lines", () => {
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
    responseUser("/yes"),
    eventUser("/always"),
    responseUser("<permissions instructions>\ninternal sandbox metadata"),
    responseUser("yes please"),
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
  assert.equal(dayRecords.filter((record) => record.type === "user" && record.text === "yes please").length, 1)
  assert.equal(dayRecords.some((record) => /^\/(?:yes|always|no)\b/iu.test(record.text)), false)
  assert.equal(dayRecords.some((record) => record.text.includes("permissions instructions")), false)
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

  const mediaRecord = dayRecords.find((record) => (
    record.type === "assistant"
    && record.text === ""
    && record.meta.attachments.some((item) => item.fileName === "attachment.png")
  ))
  assert.equal(mediaRecord.source.sourceLine, 12)
  assert.equal(mediaRecord.meta.attachments.length, 1)
  assert.equal(mediaRecord.meta.files.length, 0)
  assert.equal(mediaRecord.meta.attachments[0].kind, "image")
  assert.equal(mediaRecord.meta.attachments[0].relativePath, "inbox/2026-06-23/attachment.png")
})

test("claudecode import keeps approvals internal and preserves operations, system action mode, and visible media", () => {
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
    claudeUser("claude-session-1", "prompt-approval-1", "user-approval-1", "/no"),
    claudeUser("claude-session-1", "prompt-permission-1", "user-permission-1", "<permissions instructions>\ninternal permission metadata"),
    claudeUser("claude-session-1", "prompt-ordinary-yes", "user-ordinary-yes", "yes please"),
    { type: "control_request", request_id: "approval-1", request: { subtype: "can_use_tool", tool_name: "Bash" } },
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
  assert.equal(dayRecords.filter((record) => record.type === "user" && record.text === "yes please").length, 1)
  assert.equal(dayRecords.some((record) => /^\/(?:yes|always|no)\b/iu.test(record.text)), false)
  assert.equal(dayRecords.some((record) => record.text.includes("permissions instructions")), false)
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

  const mediaRecord = dayRecords.find((record) => (
    record.type === "assistant"
    && record.text === ""
    && record.meta.attachments.some((item) => item.fileName === "attachment.png")
  ))
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
      pendingInboundTtlMs: 365 * 24 * 60 * 60 * 1000,
    },
  })

  archive.recordInboundMessage({
    provider: "weixin",
    messageId: "wx-1",
    text: "hello realtime",
    receivedAt: "2026-06-18T01:00:00.000Z",
    attachments: [{ path: inboxFile, kind: "image", fileName: "attachment.png" }],
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
  const userRecord = dayRecords.find((record) => record.type === "user" && record.text === "hello realtime")
  assert.equal(userRecord.source.provider, "codex")
  assert.equal(userRecord.source.sourceLine, 3)
  assert.equal(userRecord.timestamp, "2026-06-18T01:00:00.000Z")
  assert.equal(userRecord.meta.messageId, "wx-1")
  assert.equal(userRecord.meta.attachments.length, 1)
  assert.equal(userRecord.meta.attachments[0].relativePath, "inbox/2026-06-23/attachment.png")
  assert.equal(userRecord.meta.sourceKey, userRecord.source.sourceKey)
  assert.match(userRecord.id, /^codex:[0-9a-f]{16}$/u)
  assert.equal(userRecord.id.includes(sourceFile), false)

  const operation = dayRecords.find((record) => record.type === "operation" && record.meta.toolName === "cyberboss_channel_send_file")
  const media = dayRecords.find((record) => (
    record.type === "assistant"
    && record.text === ""
    && record.meta.attachments.some((item) => item.fileName === "attachment.png")
  ))
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
  assert.equal(dayRecords.filter((record) => (
    record.type === "assistant"
    && record.text === ""
    && record.meta.attachments.some((item) => item.fileName === "attachment.png")
  )).length, 1)

  const operation = dayRecords.find((record) => record.type === "operation" && record.text === "[cyberboss_channel_send_file] attachment.png")
  assert.equal(operation.meta.toolName, "cyberboss_channel_send_file")
  assert.equal(operation.source.sourceLine, 2)

  const visible = dayRecords.find((record) => (
    record.type === "assistant"
    && record.text === ""
    && record.meta.attachments.some((item) => item.fileName === "attachment.png")
  ))
  assert.equal(visible.source.sourceLine, 3)
})

test("realtime media-only user records merge pending inbound once for image and file", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-media-only-"))
  const sourceFile = path.join(stateDir, "codex-media-only.jsonl")
  const imageFile = path.join(stateDir, "inbox", "2026-06-26", "a.png")
  const textFile = path.join(stateDir, "inbox", "2026-06-26", "a.txt")
  fs.mkdirSync(path.dirname(imageFile), { recursive: true })
  fs.writeFileSync(imageFile, "png", "utf8")
  fs.writeFileSync(textFile, "txt", "utf8")

  writeJsonlFixture(sourceFile, [
    sessionMeta("codex-media-only-1", "2026-06-26T02:00:00.000Z"),
    turnContext("turn-image-1", "2026-06-26T02:00:00.010Z"),
    responseUser([
      "Saved attachments:",
      `- [image] ${toSlash(imageFile)}`,
      "Use the saved local files if they are needed for the request.",
    ].join("\n"), "2026-06-26T02:00:00.020Z"),
    turnContext("turn-file-1", "2026-06-26T02:00:01.000Z"),
    responseUser([
      "Saved attachments:",
      `- [file] ${toSlash(textFile)}`,
      "Use the saved local files if they are needed for the request.",
    ].join("\n"), "2026-06-26T02:00:01.020Z"),
  ])

  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
      realtimePollIntervalMs: 60_000,
      pendingInboundTtlMs: 365 * 24 * 60 * 60 * 1000,
    },
  })

  archive.recordInboundMessage({
    provider: "weixin",
    messageId: "wx-image-1",
    receivedAt: "2026-06-26T02:00:00.005Z",
    attachments: [{ path: imageFile, kind: "image", fileName: "a.png" }],
  }, {
    runtimeId: "codex",
    threadId: "codex-media-only-1",
    workspaceRoot: WORKSPACE_ROOT,
  })

  archive.recordInboundMessage({
    provider: "weixin",
    messageId: "wx-file-1",
    receivedAt: "2026-06-26T02:00:01.005Z",
    attachments: [{ path: textFile, kind: "file", fileName: "a.txt" }],
  }, {
    runtimeId: "codex",
    threadId: "codex-media-only-1",
    workspaceRoot: WORKSPACE_ROOT,
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

  const dayRecords = readConversationDay(stateDir, "2026-06-26")
  const userRecords = dayRecords.filter((record) => record.type === "user")
  assert.equal(userRecords.length, 2)

  const imageRecord = userRecords.find((record) => record.meta.attachments.some((item) => item.fileName === "a.png"))
  assert.ok(imageRecord)
  assert.equal(imageRecord.source.provider, "codex")
  assert.equal(imageRecord.meta.messageId, "wx-image-1")
  assert.equal(imageRecord.meta.attachments.length, 1)
  assert.equal(imageRecord.meta.files.length, 0)

  const fileRecord = userRecords.find((record) => record.meta.files.some((item) => item.fileName === "a.txt"))
  assert.ok(fileRecord)
  assert.equal(fileRecord.source.provider, "codex")
  assert.equal(fileRecord.meta.messageId, "wx-file-1")
  assert.equal(fileRecord.meta.attachments.length, 0)
  assert.equal(fileRecord.meta.files.length, 1)

  assert.equal(dayRecords.some((record) => record.source.provider === "weixin"), false)
})

test("codex import extracts saved attachments into canonical user media without duplicate user rows", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-codex-media-"))
  const sourceFile = path.join(stateDir, "codex-media.jsonl")
  const imageFile = path.join(stateDir, "inbox", "2026-06-25", "attachment-2.png")
  const textFile = path.join(stateDir, "inbox", "2026-06-25", "小诗.txt")
  const stickerFile = path.join(stateDir, "stickers", "assets", "stk_025.gif")
  fs.mkdirSync(path.dirname(imageFile), { recursive: true })
  fs.mkdirSync(path.dirname(textFile), { recursive: true })
  fs.mkdirSync(path.dirname(stickerFile), { recursive: true })
  fs.writeFileSync(imageFile, "png", "utf8")
  fs.writeFileSync(textFile, "txt", "utf8")
  fs.writeFileSync(stickerFile, "gif", "utf8")

  writeJsonlFixture(sourceFile, [
    sessionMeta("codex-media-1", "2026-06-25T21:52:04.700Z"),
    turnContext("turn-media-1", "2026-06-25T21:52:04.710Z"),
    eventUser("看这个", "2026-06-25T21:52:04.720Z"),
    responseUser([
      "[2026-06-26 05:52]",
      "",
      "Saved attachments:",
      `- [image] ${imageFile}`,
      `- [file] ${textFile} (original name: 小诗.txt)`,
      `- [sticker] ${stickerFile}`,
      "Use the saved local files if they are needed for the request.",
      "",
      "Visual context from attachments:",
      `- ${imageFile}: a cute image`,
    ].join("\n"), "2026-06-25T21:52:04.730Z"),
  ])

  const importer = new ConversationImporter({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
    logger: { warn() {} },
  })

  importer.importFile({
    runtimeId: "codex",
    sourceFile,
    workspaceRoot: WORKSPACE_ROOT,
  })

  const dayRecords = readConversationDay(stateDir, "2026-06-26")
  const userRecords = dayRecords.filter((record) => record.type === "user")
  assert.equal(userRecords.length, 1)
  assert.equal(userRecords[0].text, "看这个")
  assert.equal(userRecords[0].meta.attachments.length, 2)
  assert.equal(userRecords[0].meta.files.length, 1)
  assert.equal(userRecords[0].meta.stickers.length, 1)
  assert.equal(userRecords[0].meta.attachments[0].relativePath, "inbox/2026-06-25/attachment-2.png")
  assert.equal(userRecords[0].meta.files[0].relativePath, "inbox/2026-06-25/小诗.txt")
  assert.equal(userRecords[0].meta.stickers[0].relativePath, "stickers/assets/stk_025.gif")
  assert.equal(userRecords[0].meta.files[0].path.includes("(original name:"), false)
  assert.equal("filePath" in userRecords[0].meta.files[0], false)
  assert.equal("localPath" in userRecords[0].meta.files[0], false)
  assert.equal("savedPath" in userRecords[0].meta.files[0], false)
  assert.equal("mimeType" in userRecords[0].meta.files[0], false)
  assert.equal("type" in userRecords[0].meta.files[0], false)
  assert.equal(userRecords[0].id.includes(sourceFile), false)
  assert.match(userRecords[0].id, /^codex:[0-9a-f]{16}$/u)
  assert.equal(userRecords[0].meta.sourceKey, userRecords[0].source.sourceKey)
})

test("shell command operations classify grep glob read write edit with short paths", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-shell-kinds-"))
  const sourceFile = path.join(stateDir, "codex-shells.jsonl")

  writeJsonlFixture(sourceFile, [
    sessionMeta("codex-shell-1"),
    turnContext("turn-shell-1"),
    responseFunctionCall("shell_command", { command: `Get-ChildItem -Force ${path.join(stateDir, "inbox", "2026-06-23")}` }, "call-glob-1"),
    responseFunctionCall("shell_command", { command: `rg -n "经期" "${path.join(stateDir, "diary", "2026-06-22.md")}"` }, "call-grep-1"),
    responseFunctionCall("shell_command", { command: `Get-Content "${path.join(stateDir, "diary", "2026-06-22.md")}" -Raw` }, "call-read-1"),
    responseFunctionCall("shell_command", { command: `Set-Content "${path.join(stateDir, "inbox", "2026-06-23", "小诗.txt")}" "hi"` }, "call-write-1"),
    responseFunctionCall("apply_patch", { input: "*** Begin Patch\n*** Update File: src/core/conversation/normalize-operation.js\n*** End Patch\n" }, "call-edit-1"),
  ])

  const importer = new ConversationImporter({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
    logger: { warn() {} },
  })

  importer.importFile({
    runtimeId: "codex",
    sourceFile,
    workspaceRoot: WORKSPACE_ROOT,
  })

  const dayRecords = readConversationDay(stateDir, "2026-06-14")
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "Glob inbox/2026-06-23"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "Grep 经期 diary/2026-06-22.md"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "Read diary/2026-06-22.md"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "Write inbox/2026-06-23/小诗.txt"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "Edit src/core/conversation/normalize-operation.js"))
})

test("claude source resolver supports Windows project variants and sessionId fallback", () => {
  const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-claude-paths-"))
  const projectsDir = path.join(claudeRoot, "projects")
  const projectDir = path.join(projectsDir, "D--study-cyberboss")
  fs.mkdirSync(projectDir, { recursive: true })
  const transcriptFile = path.join(projectDir, "claude-session-1.jsonl")
  fs.writeFileSync(transcriptFile, "", "utf8")

  const resolver = new ConversationSourceLineResolver({
    claudeConfigDir: claudeRoot,
  })

  const resolved = resolver.resolveSourceFile({
    runtimeId: "claudecode",
    threadId: "claude-session-1",
    workspaceRoot: "D:\\study\\cyberboss",
  })

  assert.equal(resolved, transcriptFile)
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

test("realtime parser state is isolated by source file", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-isolation-"))
  const sourceA = path.join(stateDir, "source-a.jsonl")
  const sourceB = path.join(stateDir, "source-b.jsonl")
  writeJsonlFixture(sourceA, [
    sessionMeta("thread-a"),
    turnContext("turn-a"),
    responseUser("first A"),
  ])
  writeJsonlFixture(sourceB, [
    sessionMeta("thread-b"),
    turnContext("turn-b"),
    responseUser("first B"),
  ])

  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
  })
  archive.registerRealtimeSource({ runtimeId: "codex", sourceFile: sourceA, workspaceRoot: WORKSPACE_ROOT })
  archive.registerRealtimeSource({ runtimeId: "codex", sourceFile: sourceB, workspaceRoot: WORKSPACE_ROOT })
  archive.pollRealtimeSources()

  fs.appendFileSync(sourceA, `${JSON.stringify(responseAssistant("second A"))}\n`, "utf8")
  archive.pollRealtimeSources()

  const records = [
    ...readConversationDay(stateDir, "2026-06-14"),
  ]
  assert.ok(records.some((record) => record.text === "second A" && record.threadId === "thread-a"))
  assert.equal(records.some((record) => record.text === "second A" && record.threadId === "thread-b"), false)
  assert.ok(records.filter((record) => record.threadId === "thread-b").every((record) => record.source.sourceFile === path.resolve(sourceB)))
  archive.close()
})

test("codex filename UUID takes precedence over session metadata thread id", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-thread-id-"))
  const filenameThreadId = "11111111-2222-3333-4444-555555555555"
  const sourceFile = path.join(stateDir, `${filenameThreadId}.jsonl`)
  writeJsonlFixture(sourceFile, [
    sessionMeta("payload-thread-id"),
    turnContext("turn-filename-id"),
    responseUser("filename wins"),
  ])

  const importer = new ConversationImporter({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
    logger: { warn() {} },
  })
  importer.importFile({ runtimeId: "codex", sourceFile, workspaceRoot: WORKSPACE_ROOT })

  const record = readConversationDay(stateDir, "2026-06-14").find((item) => item.text === "filename wins")
  assert.equal(record.threadId, filenameThreadId)
})

test("conversation APIs reject unknown runtimes and quarantine unmatched inbound messages", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-guards-"))
  const sourceFile = path.join(stateDir, "source.jsonl")
  writeJsonlFixture(sourceFile, [sessionMeta("thread-guard")])
  const warnings = []
  const importer = new ConversationImporter({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
    },
    logger: { warn(message) { warnings.push(message) } },
  })
  assert.throws(
    () => importer.importFile({ runtimeId: "unknown-runtime", sourceFile }),
    /unsupported conversation runtime/u,
  )

  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
      stateDir,
      pendingInboundTtlMs: 10,
    },
    logger: { warn(message) { warnings.push(message) }, error(message) { warnings.push(message) } },
  })
  archive.recordInboundMessage({
    provider: "weixin",
    messageId: "unmatched-1",
    text: "will not be silently lost",
    receivedAt: "2020-01-01T00:00:00.000Z",
  }, { runtimeId: "codex" })
  archive.cleanupExpiredPendingInboundRecords(Date.parse("2020-01-01T00:00:01.000Z"))
  const quarantineFile = path.join(stateDir, "conversations", "_unmatched-inbound.jsonl")
  assert.equal(fs.existsSync(quarantineFile), true)
  const quarantine = JSON.parse(fs.readFileSync(quarantineFile, "utf8").trim())
  assert.equal(quarantine.type, "unmatched_inbound")
  assert.equal(quarantine.inbound.messageId, "unmatched-1")
  assert.ok(warnings.some((message) => message.includes("quarantined")))
  archive.close()
})

test("conversation writer reports actual changes, rejects empty directories, and closes polling", () => {
  assert.throws(() => new ConversationWriter(), /requires conversationDir/u)
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-writer-"))
  const writer = new ConversationWriter({ conversationDir: path.join(stateDir, "conversations") })
  const input = {
    type: "user",
    timestamp: "2026-06-14T08:23:11.500Z",
    runtimeId: "codex",
    threadId: "thread-writer",
    turnId: "turn-writer",
    workspaceRoot: WORKSPACE_ROOT,
    text: "first",
    source: {
      provider: "codex",
      sourceFile: path.join(stateDir, "source.jsonl"),
      sourceLine: 1,
      rawId: "writer-1",
    },
  }
  assert.equal(writer.writeRecords([input]).writtenCount, 1)
  assert.equal(writer.writeRecords([input]).writtenCount, 0)
  assert.equal(writer.writeRecords([{ ...input, text: "updated" }]).updatedCount, 1)

  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "archive"),
      stateDir,
      maxTrackedRealtimeSources: 1,
    },
  })
  archive.registerRealtimeSource({ runtimeId: "codex", threadId: "thread-a", sourceFile: path.join(stateDir, "a.jsonl") })
  archive.registerRealtimeSource({ runtimeId: "codex", threadId: "thread-b", sourceFile: path.join(stateDir, "b.jsonl") })
  assert.equal(archive.trackedRealtimeSources.size, 1)
  assert.equal(archive.closed, false)
  archive.close()
  assert.equal(archive.closed, true)
  assert.equal(archive.realtimePollTimer, null)
})

test("realtime checkpoint survives restart and does not replay deleted history", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-restart-"))
  const sourceFile = path.join(stateDir, "claude-restart.jsonl")
  writeJsonlFixture(sourceFile, [
    claudeUser("claude-restart-1", "prompt-old", "user-old", "old history"),
  ])

  const config = {
    conversationDir: path.join(stateDir, "conversations"),
    stateDir,
    conversationDeletionStateFile: path.join(stateDir, "conversation-deletion-state.json"),
  }
  const first = new ConversationArchive({ config })
  first.registerRealtimeSource({
    runtimeId: "claudecode",
    threadId: "claude-restart-1",
    workspaceRoot: WORKSPACE_ROOT,
    sourceFile,
  })
  first.pollRealtimeSources()

  const dayFile = path.join(config.conversationDir, "2026-06-17.jsonl")
  const oldRecord = readConversationDay(stateDir, "2026-06-17").find((record) => record.text === "old history")
  assert.ok(oldRecord)
  const remaining = readConversationDay(stateDir, "2026-06-17")
    .filter((record) => record.source.sourceKey !== oldRecord.source.sourceKey)
  fs.writeFileSync(dayFile, `${remaining.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8")
  first.close()

  const checkpointFile = path.join(stateDir, "conversation-realtime-checkpoints.json")
  assert.equal(fs.existsSync(checkpointFile), true)

  const second = new ConversationArchive({ config })
  second.registerRealtimeSource({
    runtimeId: "claudecode",
    threadId: "claude-restart-1",
    workspaceRoot: WORKSPACE_ROOT,
    sourceFile,
  })
  second.pollRealtimeSources()
  assert.equal(readConversationDay(stateDir, "2026-06-17").some((record) => record.text === "old history"), false)

  fs.appendFileSync(sourceFile, `${JSON.stringify(claudeUser(
    "claude-restart-1",
    "prompt-new",
    "user-new",
    "new after restart",
    "2026-06-17T05:52:00.000Z",
  ))}\n`, "utf8")
  second.pollRealtimeSources()
  const afterRestart = readConversationDay(stateDir, "2026-06-17")
  assert.equal(afterRestart.some((record) => record.text === "old history"), false)
  assert.equal(afterRestart.filter((record) => record.text === "new after restart").length, 1)

  const deletionState = JSON.parse(fs.readFileSync(path.join(stateDir, "conversation-deletion-state.json"), "utf8"))
  assert.ok(deletionState.deletedSourceKeys.includes(oldRecord.source.sourceKey))
  second.close()
})

test("realtime checkpoint hydrates parser state before reading new tool results", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-hydrate-"))
  const sourceFile = path.join(stateDir, "claude-hydrate.jsonl")
  writeJsonlFixture(sourceFile, [
    claudeAssistant("claude-hydrate-1", "assistant-tool-1", "turn-hydrate-1", [
      { type: "tool_use", id: "tool-hydrate-1", name: "Read", input: { file_path: "src/core/app.js" } },
    ]),
  ])

  const config = {
    conversationDir: path.join(stateDir, "conversations"),
    stateDir,
  }
  const first = new ConversationArchive({ config })
  first.registerRealtimeSource({
    runtimeId: "claudecode",
    threadId: "claude-hydrate-1",
    workspaceRoot: WORKSPACE_ROOT,
    sourceFile,
  })
  first.pollRealtimeSources()
  const initialOperation = readConversationDay(stateDir, "2026-06-17")
    .find((record) => record.type === "operation")
  assert.ok(initialOperation)
  assert.equal(initialOperation.meta.toolResultPreview, undefined)
  first.close()

  fs.appendFileSync(sourceFile, `${JSON.stringify(claudeToolResult(
    "claude-hydrate-1",
    "tool-result-hydrate-1",
    "tool-hydrate-1",
    "read completed",
    "2026-06-17T05:51:40.000Z",
  ))}\n`, "utf8")

  const second = new ConversationArchive({ config })
  second.registerRealtimeSource({
    runtimeId: "claudecode",
    threadId: "claude-hydrate-1",
    workspaceRoot: WORKSPACE_ROOT,
    sourceFile,
  })
  second.pollRealtimeSources()
  const hydratedOperation = readConversationDay(stateDir, "2026-06-17")
    .find((record) => record.type === "operation")
  assert.equal(hydratedOperation.meta.toolResultPreview, "read completed")
  second.close()
})

test("realtime ignores in-place historical edits and keeps manual conversation edits", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-source-edit-"))
  const sourceFile = path.join(stateDir, "claude-source-edit.jsonl")
  const config = {
    conversationDir: path.join(stateDir, "conversations"),
    stateDir,
  }
  writeJsonlFixture(sourceFile, [
    claudeUser("claude-source-edit-1", "prompt-old", "user-old", "old history"),
  ])

  const archive = new ConversationArchive({ config })
  archive.registerRealtimeSource({
    runtimeId: "claudecode",
    threadId: "claude-source-edit-1",
    workspaceRoot: WORKSPACE_ROOT,
    sourceFile,
  })
  archive.pollRealtimeSources()

  const dayFile = path.join(config.conversationDir, "2026-06-17.jsonl")
  const originalConversation = fs.readFileSync(dayFile, "utf8")
  const manuallyEditedConversation = originalConversation.replace("old history", "manual conversation edit")
  fs.writeFileSync(dayFile, manuallyEditedConversation, "utf8")

  fs.writeFileSync(sourceFile, `${JSON.stringify(claudeUser(
    "claude-source-edit-1",
    "prompt-rewritten",
    "user-rewritten",
    `rewritten historical content ${"x".repeat(500)}`,
  ))}\n`, "utf8")
  const rewriteResult = archive.pollRealtimeSources()
  assert.ok(rewriteResult.warnings.some((warning) => warning.includes("Ignored non-append realtime source change")))
  assert.equal(fs.readFileSync(dayFile, "utf8"), manuallyEditedConversation)
  assert.equal(readConversationDay(stateDir, "2026-06-17").some((record) => record.text.includes("rewritten historical")), false)

  fs.appendFileSync(sourceFile, `${JSON.stringify(claudeUser(
    "claude-source-edit-1",
    "prompt-new",
    "user-new",
    "new realtime history",
    "2026-06-17T05:52:00.000Z",
  ))}\n`, "utf8")
  archive.pollRealtimeSources()
  const afterAppend = readConversationDay(stateDir, "2026-06-17")
  assert.equal(afterAppend.filter((record) => record.text === "new realtime history").length, 1)
  assert.equal(afterAppend.filter((record) => record.text === "manual conversation edit").length, 1)
  archive.close()
})

test("realtime ignores deleted and recreated session files, then accepts later appends", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-source-recreate-"))
  const sourceFile = path.join(stateDir, "claude-source-recreate.jsonl")
  const config = {
    conversationDir: path.join(stateDir, "conversations"),
    stateDir,
  }
  writeJsonlFixture(sourceFile, [
    claudeUser("claude-source-recreate-1", "prompt-old-1", "user-old-1", "old history 1"),
    claudeUser("claude-source-recreate-1", "prompt-old-2", "user-old-2", "old history 2"),
    claudeUser("claude-source-recreate-1", "prompt-old-3", "user-old-3", "old history 3"),
  ])

  const archive = new ConversationArchive({ config })
  archive.registerRealtimeSource({
    runtimeId: "claudecode",
    threadId: "claude-source-recreate-1",
    workspaceRoot: WORKSPACE_ROOT,
    sourceFile,
  })
  archive.pollRealtimeSources()

  const dayFile = path.join(config.conversationDir, "2026-06-17.jsonl")
  const beforeDelete = fs.readFileSync(dayFile, "utf8")
  archive.close()
  fs.rmSync(sourceFile)
  const restarted = new ConversationArchive({ config })
  restarted.registerRealtimeSource({
    runtimeId: "claudecode",
    threadId: "claude-source-recreate-1",
    workspaceRoot: WORKSPACE_ROOT,
    sourceFile,
  })
  restarted.pollRealtimeSources()
  assert.equal(fs.readFileSync(dayFile, "utf8"), beforeDelete)

  writeJsonlFixture(sourceFile, [
    claudeUser("claude-source-recreate-1", "prompt-recreated", "user-recreated", "recreated history"),
  ])
  const recreateResult = restarted.pollRealtimeSources()
  assert.ok(recreateResult.warnings.some((warning) => warning.includes("Ignored non-append realtime source change")))
  assert.equal(fs.readFileSync(dayFile, "utf8"), beforeDelete)
  assert.equal(readConversationDay(stateDir, "2026-06-17").some((record) => record.text === "recreated history"), false)

  fs.appendFileSync(sourceFile, `${JSON.stringify(claudeUser(
    "claude-source-recreate-1",
    "prompt-new",
    "user-new",
    "new after recreate",
    "2026-06-17T05:52:00.000Z",
  ))}\n`, "utf8")
  restarted.pollRealtimeSources()
  const afterAppend = readConversationDay(stateDir, "2026-06-17")
  assert.equal(afterAppend.filter((record) => record.text === "new after recreate").length, 1)
  assert.equal(afterAppend.filter((record) => record.text.startsWith("old history")).length, 3)
  restarted.close()
})

test("conversation writer persists tombstones when a source key is manually removed", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-tombstone-"))
  const conversationDir = path.join(stateDir, "conversations")
  const sourceFile = path.join(stateDir, "source.jsonl")
  const writer = new ConversationWriter({
    conversationDir,
    deletionStateFile: path.join(stateDir, "conversation-deletion-state.json"),
  })
  const input = {
    type: "user",
    timestamp: "2026-06-14T08:23:11.500Z",
    runtimeId: "codex",
    threadId: "thread-tombstone",
    turnId: "turn-tombstone",
    workspaceRoot: WORKSPACE_ROOT,
    text: "remove me",
    source: {
      provider: "codex",
      sourceFile,
      sourceLine: 1,
      rawId: "tombstone-1",
    },
  }
  writer.writeRecords([input])
  const dayFile = path.join(conversationDir, "2026-06-14.jsonl")
  const writtenRecord = JSON.parse(fs.readFileSync(dayFile, "utf8").trim())
  fs.writeFileSync(dayFile, "", "utf8")

  const replay = writer.writeRecords([input])
  assert.equal(replay.writtenCount, 0)
  assert.equal(replay.ignoredCount, 1)
  assert.equal(fs.readFileSync(dayFile, "utf8"), "")
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "conversation-deletion-state.json"), "utf8"))
  assert.ok(state.deletedSourceKeys.includes(writtenRecord.source.sourceKey))
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
