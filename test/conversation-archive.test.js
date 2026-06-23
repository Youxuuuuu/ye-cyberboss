const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  ConversationArchive,
  ConversationImporter,
} = require("../src/core/conversation")

test("codex session import writes only supported conversation records, dedupes, and keeps source immutable", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-codex-"))
  const sourceFile = path.join(stateDir, "codex-session.jsonl")
  const systemActionPrompt = [
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Do any timeline/diary/reminder/whereabouts work in this turn.",
    "Trigger:",
    "codex internal patrol",
  ].join("\n")
  const wechatInstructionsPrompt = [
    "WECHAT SESSION INSTRUCTIONS",
    "These instructions define the stable behavior for this WeChat thread.",
    "",
    "Current user message:",
    "hidden user content",
  ].join("\n")
  writeJsonlFixture(sourceFile, [
    {
      timestamp: "2026-06-14T08:23:11.319Z",
      type: "session_meta",
      payload: {
        id: "codex-session-1",
        cwd: "D:\\study\\cyberboss",
      },
    },
    {
      timestamp: "2026-06-14T08:23:11.400Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-codex-1",
      },
    },
    {
      timestamp: "2026-06-14T08:23:11.500Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-codex-1",
        cwd: "D:\\study\\cyberboss",
        workspace_roots: ["D:\\study\\cyberboss"],
      },
    },
    {
      timestamp: "2026-06-14T08:23:11.600Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "skip developer" }],
      },
    },
    {
      timestamp: "2026-06-14T08:23:11.800Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: systemActionPrompt }],
      },
    },
    {
      timestamp: "2026-06-14T08:23:11.810Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: systemActionPrompt,
      },
    },
    {
      timestamp: "2026-06-14T08:23:11.900Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: wechatInstructionsPrompt }],
      },
    },
    {
      timestamp: "2026-06-14T08:23:11.910Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: wechatInstructionsPrompt,
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello codex" }],
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.010Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "hello codex",
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.100Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "Read",
        arguments: JSON.stringify({
          filePath: "D:\\study\\cyberboss\\src\\core\\app.js",
        }),
        call_id: "call-read-1",
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.200Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-read-1",
        output: "Read completed\n{\"filePath\":\"D:\\\\study\\\\cyberboss\\\\src\\\\core\\\\app.js\"}",
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.250Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        status: "completed",
        call_id: "call-patch-1",
        input: "*** Begin Patch\n*** Update File: src/core/app.js\n@@\n-old\n+new\n*** End Patch\n",
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.260Z",
      type: "response_item",
      payload: {
        type: "patch_apply_end",
        call_id: "call-patch-end-1",
        input: "*** Begin Patch\n*** Update File: src/core/conversation/recorder.js\n@@\n-older\n+newer\n*** End Patch\n",
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.300Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "mcp__cyberboss_tools__cyberboss_channel_send_file",
        arguments: JSON.stringify({
          filePath: "D:\\study\\cyberboss\\tmp\\report.png",
        }),
        call_id: "call-send-file-1",
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.350Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-send-file-1",
        output: "File sent: D:\\study\\cyberboss\\tmp\\report.png\n{\n  \"userId\": \"wx-1\",\n  \"filePath\": \"D:\\\\study\\\\cyberboss\\\\tmp\\\\report.png\"\n}",
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.450Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "done codex",
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.500Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done codex" }],
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.550Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        encrypted_content: "secret",
      },
    },
    {
      timestamp: "2026-06-14T08:23:12.600Z",
      type: "event_msg",
      payload: {
        type: "token_count",
      },
    },
  ], {
    trailingInvalidLine: "{bad json",
  })

  const before = fs.statSync(sourceFile)
  const importer = new ConversationImporter({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
    },
    logger: { warn() {} },
  })

  const firstImport = importer.importFile({
    runtimeId: "codex",
    sourceFile,
    workspaceRoot: "D:\\study\\cyberboss",
  })
  const after = fs.statSync(sourceFile)

  assert.equal(before.size, after.size)
  assert.equal(before.mtimeMs, after.mtimeMs)
  assert.equal(firstImport.warnings.length, 1)

  const dayRecords = readConversationDay(stateDir, "2026-06-14")
  assert.ok(dayRecords.length >= 5)
  assert.ok(dayRecords.every((record) => ["user", "assistant", "operation"].includes(record.type)))
  assert.equal(dayRecords.some((record) => record.type === "thinking"), false)
  assert.equal(dayRecords.some((record) => /developer/i.test(record.text)), false)
  assert.equal(dayRecords.some((record) => /token_count/i.test(record.text)), false)
  assert.equal(dayRecords.some((record) => /secret/i.test(record.text)), false)
  assert.equal(dayRecords.some((record) => /SYSTEM ACTION MODE/u.test(record.text)), false)
  assert.equal(dayRecords.some((record) => /WECHAT SESSION INSTRUCTIONS/u.test(record.text)), false)
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "Read D:\\study\\cyberboss\\src\\core\\app.js"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "Edit src/core/app.js"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "Edit src/core/conversation/recorder.js"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && /Send file report\.png/u.test(record.text)))
  assert.ok(dayRecords.some((record) => (
    record.type === "assistant"
    && Array.isArray(record.meta.files)
    && record.meta.files.length === 1
    && Array.isArray(record.meta.attachments)
    && record.meta.attachments.length === 1
    && record.meta.files[0].isImage === true
  )))
  assert.equal(dayRecords.filter((record) => record.type === "user" && record.text === "hello codex").length, 1)
  assert.equal(dayRecords.filter((record) => record.type === "assistant" && record.text === "done codex").length, 1)
  assert.ok(dayRecords.some((record) => (
    record.type === "user"
    && record.text === ""
    && record.meta.visibleAs === "system_compact"
    && record.meta.displayText === "宝宝大王系统巡游"
    && record.meta.systemKind === "action_mode"
    && record.source.sourceType === "codex.system_action_mode"
  )))
  assert.ok(dayRecords.every((record) => record.source.sourceKey && record.meta.sourceKey === record.source.sourceKey))

  importer.importFile({
    runtimeId: "codex",
    sourceFile,
    workspaceRoot: "D:\\study\\cyberboss",
  })
  const secondPass = readConversationDay(stateDir, "2026-06-14")
  assert.equal(secondPass.length, dayRecords.length)
})

test("claudecode session import keeps only displayable records and preserves thinking plus operation summaries", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-claude-"))
  const sourceFile = path.join(stateDir, "claude-session.jsonl")
  const systemActionPrompt = [
    "[2026-06-17 13:52]",
    "",
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Do any timeline/diary/reminder/whereabouts work in this turn.",
    "Trigger:",
    "宝宝巡游一下",
  ].join("\n")
  const wechatInstructionsPrompt = [
    "WECHAT SESSION INSTRUCTIONS",
    "These instructions define the stable behavior for this WeChat thread.",
    "",
    "Current user message:",
    "this should not be archived",
  ].join("\n")
  writeJsonlFixture(sourceFile, [
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-06-17T05:16:32.960Z",
      sessionId: "claude-session-1",
      content: "skip queue",
    },
    {
      type: "user",
      timestamp: "2026-06-17T05:51:38.091Z",
      sessionId: "claude-session-1",
      cwd: "D:\\study\\cyberboss",
      promptId: "prompt-1",
      uuid: "user-1",
      message: {
        role: "user",
        content: "[2026-06-17 13:51]\n\n[Quoted: line one\nline two]\nhello claude",
      },
    },
    {
      type: "user",
      timestamp: "2026-06-17T05:51:38.500Z",
      sessionId: "claude-session-1",
      cwd: "D:\\study\\cyberboss",
      promptId: "prompt-system-action",
      uuid: "user-system-action-1",
      message: {
        role: "user",
        content: systemActionPrompt,
      },
    },
    {
      type: "user",
      timestamp: "2026-06-17T05:51:38.700Z",
      sessionId: "claude-session-1",
      cwd: "D:\\study\\cyberboss",
      promptId: "prompt-instructions",
      uuid: "user-instructions-1",
      message: {
        role: "user",
        content: wechatInstructionsPrompt,
      },
    },
    {
      type: "assistant",
      timestamp: "2026-06-17T05:51:39.000Z",
      sessionId: "claude-session-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "assistant-1",
      parentUuid: "user-1",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan first" },
          { type: "tool_use", id: "tool-write-1", name: "Write", input: { file_path: "D:\\study\\cyberboss\\src\\core\\app.js" } },
          { type: "text", text: "hello from claude" },
        ],
      },
    },
    {
      type: "user",
      timestamp: "2026-06-17T05:51:39.500Z",
      sessionId: "claude-session-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "user-tool-result-1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-write-1", content: "Write completed", is_error: false },
        ],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-06-17T05:51:40.000Z",
      sessionId: "claude-session-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "assistant-2",
      parentUuid: "user-1",
      message: {
        id: "msg-2",
        type: "message",
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-sticker-1", name: "mcp__cyberboss_tools__cyberboss_sticker_send", input: { stickerId: "stk_001" } },
          { type: "text", text: "sticker done" },
        ],
      },
    },
    {
      type: "user",
      timestamp: "2026-06-17T05:51:40.500Z",
      sessionId: "claude-session-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "user-tool-result-2",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-sticker-1",
            content: "Sticker sent: stk_001\n{\n  \"stickerId\": \"stk_001\",\n  \"filePath\": \"D:\\\\study\\\\cyberboss\\\\tmp\\\\stk_001.gif\"\n}",
          },
        ],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-06-17T05:51:41.000Z",
      sessionId: "claude-session-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "assistant-silent-1",
      parentUuid: "user-1",
      message: {
        id: "msg-silent",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "{\"action\":\"silent\"}" },
        ],
      },
    },
    {
      type: "user",
      timestamp: "2026-06-17T05:51:41.500Z",
      sessionId: "claude-session-1",
      cwd: "D:\\study\\cyberboss",
      promptId: "prompt-approval",
      uuid: "user-approval-1",
      message: {
        role: "user",
        content: "/yes",
      },
    },
    {
      type: "ai-title",
      timestamp: "2026-06-17T05:51:42.000Z",
      sessionId: "claude-session-1",
      content: "skip title",
    },
    {
      type: "mode",
      timestamp: "2026-06-17T05:51:42.100Z",
      sessionId: "claude-session-1",
      content: "skip mode",
    },
    {
      type: "file-history-snapshot",
      timestamp: "2026-06-17T05:51:42.200Z",
      sessionId: "claude-session-1",
      content: "skip history",
    },
    {
      type: "system",
      timestamp: "2026-06-17T05:51:42.300Z",
      sessionId: "claude-session-1",
      content: "skip system",
    },
  ])

  const importer = new ConversationImporter({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
    },
    logger: { warn() {} },
  })
  const before = fs.statSync(sourceFile)
  importer.importFile({
    runtimeId: "claudecode",
    sourceFile,
    workspaceRoot: "D:\\study\\cyberboss",
  })
  const after = fs.statSync(sourceFile)

  const dayRecords = readConversationDay(stateDir, "2026-06-17")
  assert.ok(dayRecords.length >= 5)
  assert.ok(dayRecords.every((record) => ["user", "assistant", "thinking", "operation"].includes(record.type)))
  assert.equal(before.size, after.size)
  assert.equal(before.mtimeMs, after.mtimeMs)
  assert.equal(dayRecords.some((record) => /SYSTEM ACTION MODE/u.test(record.text)), false)
  assert.equal(dayRecords.some((record) => /WECHAT SESSION INSTRUCTIONS/u.test(record.text)), false)
  assert.equal(dayRecords.filter((record) => record.type === "user" && record.meta.visibleAs !== "system_compact").length, 1)
  assert.ok(dayRecords.some((record) => record.type === "thinking" && record.text === "plan first"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.meta.toolName === "Write"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.meta.resultSummary === "Write completed"))
  assert.ok(dayRecords.some((record) => (
    record.type === "assistant"
    && Array.isArray(record.meta.stickers)
    && record.meta.stickers.length === 1
    && Array.isArray(record.meta.attachments)
    && record.meta.attachments.length === 1
    && record.meta.stickers[0].isImage === true
  )))
  assert.equal(dayRecords.some((record) => record.text === "/yes"), false)
  assert.equal(dayRecords.some((record) => /queue|title|history|mode|system/iu.test(record.text)), false)
  assert.ok(dayRecords.some((record) => (
    record.type === "user"
    && record.text === ""
    && record.meta.visibleAs === "system_compact"
    && record.meta.displayText === "宝宝大王系统巡游"
    && record.meta.systemKind === "action_mode"
    && record.source.sourceType === "claudecode.system_action_mode"
  )))

  const firstUser = dayRecords.find((record) => record.type === "user" && record.meta.visibleAs !== "system_compact")
  assert.equal(firstUser.text, "hello claude")
  assert.equal(firstUser.timestamp, "2026-06-17T05:51:00.000Z")
  assert.equal(firstUser.meta.quote, "line one\nline two")
})

test("realtime archive records inbound user content plus codex and claudecode raw events in MurmurLane-compatible shape", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-realtime-"))
  const attachmentPath = path.join(stateDir, "inbox-image.png")
  fs.writeFileSync(attachmentPath, "fake-image", "utf8")

  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
    },
  })

  archive.recordInboundMessage({
    provider: "weixin",
    messageId: "wx-1",
    originalText: "[Quoted: earlier note]\nNeed this file",
    text: "[Quoted: earlier note]\nNeed this file",
    receivedAt: "2026-06-18T01:00:00.000Z",
    attachments: [{
      kind: "file",
      fileName: "inbox-image.png",
      absolutePath: attachmentPath,
      relativePath: "inbox/2026-06-18/inbox-image.png",
      contentType: "image/png",
      isImage: true,
    }],
  }, {
    runtimeId: "claudecode",
    threadId: "thread-weixin-1",
    turnId: "",
    workspaceRoot: "D:\\study\\cyberboss",
  })

  archive.recordRuntimeRaw({
    runtimeId: "claudecode",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      type: "user",
      timestamp: "2026-06-18T01:00:00.500Z",
      sessionId: "claude-rt-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "claude-system-action-1",
      message: {
        role: "user",
        content: "[2026-06-18 09:00]\n\nSYSTEM ACTION MODE: internal trigger, not user chat.\nTrigger:\nclaude patrol",
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "claudecode",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      type: "user",
      timestamp: "2026-06-18T01:00:00.700Z",
      sessionId: "claude-rt-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "claude-instructions-1",
      message: {
        role: "user",
        content: "WECHAT SESSION INSTRUCTIONS\nCurrent user message:\nshould drop",
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "claudecode",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      type: "user",
      timestamp: "2026-06-18T01:00:00.800Z",
      sessionId: "claude-rt-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "claude-user-plain-1",
      message: {
        role: "user",
        content: "plain claude realtime user",
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "claudecode",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      type: "assistant",
      timestamp: "2026-06-18T01:00:01.000Z",
      sessionId: "claude-rt-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "claude-assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "think once" },
          { type: "tool_use", id: "claude-tool-1", name: "Write", input: { file_path: "D:\\study\\cyberboss\\src\\core\\config.js" } },
          { type: "text", text: "claude realtime reply" },
        ],
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "claudecode",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      type: "user",
      timestamp: "2026-06-18T01:00:01.500Z",
      sessionId: "claude-rt-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "claude-tool-result-1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "claude-tool-1", content: "Write finished", is_error: false },
        ],
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "claudecode",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      type: "assistant",
      timestamp: "2026-06-18T01:00:01.600Z",
      sessionId: "claude-rt-1",
      cwd: "D:\\study\\cyberboss",
      uuid: "claude-mcp-1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "claude-tool-mcp-1", name: "mcp__cyberboss_tools__cyberboss_reminder_create", input: { text: "drink water" } },
        ],
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "claudecode",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      type: "control_request",
      timestamp: "2026-06-18T01:00:01.700Z",
      sessionId: "claude-rt-1",
    },
  })

  archive.recordRuntimeRaw({
    runtimeId: "codex",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      method: "turn/started",
      params: {
        threadId: "codex-rt-1",
        turn: { id: "turn-rt-1" },
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "codex",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      method: "item/completed",
      params: {
        threadId: "codex-rt-1",
        turn: { id: "turn-rt-1" },
        item: {
          id: "codex-user-system-1",
          type: "userMessage",
          text: "SYSTEM ACTION MODE: internal trigger, not user chat.\nTrigger:\ncodex patrol",
        },
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "codex",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      method: "item/completed",
      params: {
        threadId: "codex-rt-1",
        turn: { id: "turn-rt-1" },
        item: {
          id: "codex-user-instructions-1",
          type: "userMessage",
          text: "WECHAT SESSION INSTRUCTIONS\nCurrent user message:\nshould drop",
        },
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "codex",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      method: "item/completed",
      params: {
        threadId: "codex-rt-1",
        turn: { id: "turn-rt-1" },
        item: {
          id: "codex-user-plain-1",
          type: "userMessage",
          text: "plain codex realtime user",
        },
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "codex",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      method: "item/completed",
      params: {
        threadId: "codex-rt-1",
        turn: { id: "turn-rt-1" },
        item: {
          id: "codex-op-1",
          type: "functionCall",
          name: "shell_command",
          input: {
            command: "rg -n conversation src",
          },
        },
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "codex",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      method: "item/completed",
      params: {
        threadId: "codex-rt-1",
        turn: { id: "turn-rt-1" },
        item: {
          id: "codex-msg-1",
          type: "agentMessage",
          text: "codex realtime reply",
        },
      },
    },
  })
  archive.recordRuntimeRaw({
    runtimeId: "codex",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      method: "execCommand/requestApproval",
      params: {
        threadId: "codex-rt-1",
        turn: { id: "turn-rt-1" },
      },
    },
  })

  const dayRecords = readConversationDay(stateDir, "2026-06-18")
  assert.ok(dayRecords.some((record) => record.type === "user" && record.text === "Need this file"))
  assert.ok(dayRecords.some((record) => record.type === "user" && record.text === "plain claude realtime user"))
  assert.ok(dayRecords.some((record) => record.type === "user" && record.text === "plain codex realtime user"))
  assert.ok(dayRecords.some((record) => record.type === "thinking" && record.text === "think once"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.meta.resultSummary === "Write finished"))
  assert.ok(dayRecords.some((record) => record.type === "assistant" && record.text === "claude realtime reply"))
  assert.ok(dayRecords.some((record) => record.type === "assistant" && record.text === "codex realtime reply"))
  assert.ok(dayRecords.some((record) => record.type === "operation" && /Run rg -n conversation src/u.test(record.text)))
  assert.ok(dayRecords.some((record) => record.type === "operation" && record.text === "cyberboss_reminder_create"))
  assert.equal(dayRecords.some((record) => /requestApproval/u.test(record.text)), false)
  assert.equal(dayRecords.some((record) => /SYSTEM ACTION MODE/u.test(record.text)), false)
  assert.equal(dayRecords.some((record) => /WECHAT SESSION INSTRUCTIONS/u.test(record.text)), false)
  assert.equal(dayRecords.filter((record) => record.meta.visibleAs === "system_compact").length, 2)
  assert.ok(dayRecords.some((record) => (
    record.type === "user"
    && record.meta.visibleAs === "system_compact"
    && record.meta.displayText === "宝宝大王系统巡游"
    && record.meta.systemKind === "action_mode"
    && record.source.sourceType === "claudecode.system_action_mode"
  )))
  assert.ok(dayRecords.some((record) => (
    record.type === "user"
    && record.meta.visibleAs === "system_compact"
    && record.meta.displayText === "宝宝大王系统巡游"
    && record.meta.systemKind === "action_mode"
    && record.source.sourceType === "codex.system_action_mode"
  )))

  const userRecord = dayRecords.find((record) => record.type === "user" && record.text === "Need this file")
  assert.equal(userRecord.meta.quote, "earlier note")
  assert.equal(Array.isArray(userRecord.meta.attachments), true)
  assert.equal(Array.isArray(userRecord.meta.files), true)
  assert.equal(Array.isArray(userRecord.meta.stickers), true)
  assert.equal(typeof userRecord.id, "string")
  assert.equal(typeof userRecord.timestamp, "string")
  assert.equal(typeof userRecord.date, "string")
  assert.equal(typeof userRecord.runtimeId, "string")
  assert.equal(typeof userRecord.threadId, "string")
  assert.equal(typeof userRecord.turnId, "string")
  assert.equal(typeof userRecord.workspaceRoot, "string")
  assert.equal(typeof userRecord.text, "string")
  assert.equal(typeof userRecord.meta.sourceKey, "string")
  assert.equal(typeof userRecord.source.sourceKey, "string")

  const operationRecord = dayRecords.find((record) => record.type === "operation" && record.meta.toolName === "Write")
  assert.equal(typeof operationRecord.meta.toolName, "string")
  assert.equal(typeof operationRecord.meta.operationKind, "string")
  assert.equal(typeof operationRecord.meta.displayPath, "string")
  assert.equal(typeof operationRecord.meta.path, "string")
})

test("realtime archive assigns positive sourceLine values and preserves equal-timestamp write order", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-order-"))
  const archive = new ConversationArchive({
    config: {
      conversationDir: path.join(stateDir, "conversations"),
    },
  })

  archive.recordInboundMessage({
    provider: "weixin",
    messageId: "wx-order-1",
    text: "same timestamp user",
    receivedAt: "2026-06-18T02:00:00.000Z",
  }, {
    runtimeId: "codex",
    threadId: "thread-order-1",
    workspaceRoot: "D:\\study\\cyberboss",
  })

  archive.recordRuntimeRaw({
    runtimeId: "codex",
    workspaceRoot: "D:\\study\\cyberboss",
    raw: {
      timestamp: "2026-06-18T02:00:00.000Z",
      method: "item/completed",
      params: {
        threadId: "thread-order-1",
        turn: { id: "turn-order-1" },
        item: {
          id: "assistant-order-1",
          type: "agentMessage",
          text: "same timestamp assistant",
        },
      },
    },
  })

  const dayRecords = readConversationDay(stateDir, "2026-06-18")
  const ordered = dayRecords.filter((record) => (
    record.text === "same timestamp user"
    || record.text === "same timestamp assistant"
  ))

  assert.equal(ordered.length, 2)
  assert.equal(ordered[0].text, "same timestamp user")
  assert.equal(ordered[1].text, "same timestamp assistant")
  assert.ok(ordered.every((record) => Number(record.source.sourceLine) > 0))
  assert.ok(ordered[0].source.sourceLine < ordered[1].source.sourceLine)
})

function writeJsonlFixture(filePath, items, { trailingInvalidLine = "" } = {}) {
  const lines = items.map((item) => JSON.stringify(item))
  if (trailingInvalidLine) {
    lines.push(trailingInvalidLine)
  }
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
