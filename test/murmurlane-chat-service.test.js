const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
  buildInboundDraft,
  buildMergedInboundPrepared,
} = require("../src/core/inbound-turn")
const { normalizeWorkspaceRoot } = require("../src/core/workspace-root")
const { isPathWithinRoot } = require("../src/adapters/runtime/shared/approval-command")
const { SessionStore } = require("../src/adapters/runtime/codex/session-store")
const { createMurmurLaneChatService } = require("../src/custom/xiaoye/murmurlane/chat-service")

test("murmurlane chat service resolves identity and status through the narrow cyberboss port", () => {
  const cursorCalls = []
  const sessionStore = {
    buildBindingKey({ workspaceId, accountId, senderId }) {
      return `${workspaceId}:${accountId}:${senderId}`
    },
    getThreadIdForWorkspace() {
      return "thread-1"
    },
    getRuntimeParamsForWorkspace() {
      return { model: "model-1", modelProvider: "provider-1" }
    },
  }
  const service = createMurmurLaneChatService({
    config: {
      workspaceId: "workspace-1",
      workspaceRoot: "D:\\study\\cyberboss",
      accountId: "",
      webChatSenderId: "",
      allowedUserIds: [],
      webChatEnabled: true,
    },
    adapter: {
      getClientCount() { return 2 },
      getEventCursor(scope) {
        cursorCalls.push(scope)
        return 73
      },
    },
    cyberbossPort: {
      resolveWeixinAccount() {
        return { accountId: "account-1", userId: "user-1" }
      },
      getActiveAccountId() {
        return ""
      },
      getRuntimeAdapter() {
        return {
          getSessionStore() { return sessionStore },
          describe() { return { id: "codex", model: "fallback-model" } },
        }
      },
      getThreadStateStore() {
        return {
          getThreadState() { return null },
          getLatestContext() { return null },
        }
      },
      resolveWorkspaceRoot() {
        return "D:/study/cyberboss"
      },
      async routePreparedInbound() {
        return { accepted: true }
      },
      findModelByQuery() { return null },
      isPathWithinRoot() { return true },
      buildInboundDraft(value) { return value },
      buildMergedInboundPrepared(value) { return value },
      normalizeWorkspaceRoot(value) { return String(value || "").replace(/\\/g, "/") },
    },
  })

  assert.deepEqual(service.getWebChatIdentity(), {
    workspaceId: "workspace-1",
    workspaceRoot: "D:/study/cyberboss",
    accountId: "account-1",
    senderId: "user-1",
  })
  assert.deepEqual(service.getWebChatStatus(), {
    connected: true,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    status: "idle",
    model: "model-1",
    modelProvider: "provider-1",
    usage: null,
    pendingApproval: null,
    webClients: 2,
    eventCursor: 73,
  })
  assert.deepEqual(cursorCalls, [{
    senderId: "user-1",
    threadId: "thread-1",
  }])
})

test("murmurlane chat service delegates deletion of an idle thread to conversation commands", async () => {
  const harness = createThreadDeleteHarness({ threadState: { status: "idle" } })

  const result = await harness.service.deleteWebChatThread({
    senderId: "user-1",
    threadId: "thread-delete",
  })

  assert.deepEqual(harness.deleteCalls, [{ threadId: "thread-delete" }])
  assert.deepEqual(result, {
    threadId: "thread-delete",
    deletedRecordCount: 2,
    touchedDates: ["2026-07-30"],
    deletedSourceKeys: ["codex|file|1"],
  })
})

test("murmurlane chat service rejects deletion while the thread has active work", async () => {
  const harness = createThreadDeleteHarness({
    threadState: {
      status: "waiting_approval",
      pendingApproval: { requestId: "approval-1" },
    },
  })

  await assert.rejects(
    () => harness.service.deleteWebChatThread({
      senderId: "user-1",
      threadId: "thread-delete",
    }),
    (error) => (
      error?.statusCode === 409
      && error?.code === "THREAD_DELETE_BUSY"
      && error?.message === "thread thread-delete has active work and cannot be deleted"
    ),
  )
  assert.deepEqual(harness.deleteCalls, [])
})

test("murmurlane chat service sends an image attachment inside the state directory", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-chat-image-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const imagePath = path.join(stateDir, "uploads", "test.png")
  fs.mkdirSync(path.dirname(imagePath), { recursive: true })
  fs.writeFileSync(imagePath, Buffer.from("test-image"))
  const harness = createAttachmentHarness({ stateDir })

  await harness.service.handleWebChatMessages({
    messages: [{
      messageId: "message-image",
      text: "",
      attachments: [{
        kind: "image",
        absolutePath: imagePath,
        fileName: "test.png",
        contentType: "image/png",
      }],
    }],
  })

  assert.equal(harness.routeCalls.length, 1)
  const attachment = harness.routeCalls[0].prepared.attachments[0]
  assert.equal(attachment.kind, "image")
  assert.equal(attachment.absolutePath, path.resolve(imagePath))
  assert.equal(attachment.relativePath, "uploads/test.png")
  assert.ok(harness.pathValidationCalls.length >= 1)
  assert.ok(harness.pathValidationCalls.every((call) => (
    call.candidate === path.resolve(imagePath)
    && call.root === path.resolve(stateDir)
  )))
})

test("murmurlane chat service preserves a file attachment when submitting inbound", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-chat-file-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const filePath = path.join(stateDir, "uploads", "notes.txt")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, "hello")
  const harness = createAttachmentHarness({ stateDir })

  await harness.service.handleWebChatMessages({
    messages: [{
      messageId: "message-file",
      text: "",
      attachments: [{
        kind: "file",
        absolutePath: filePath,
        fileName: "notes.txt",
        contentType: "text/plain",
      }],
    }],
  })

  assert.equal(harness.routeCalls.length, 1)
  assert.deepEqual(
    pickAttachmentFields(harness.routeCalls[0].prepared.attachments[0]),
    {
      kind: "file",
      fileName: "notes.txt",
      contentType: "text/plain",
      relativePath: "uploads/notes.txt",
    },
  )
})

test("murmurlane chat service sends a sticker through the attachment path", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-chat-sticker-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const stickerPath = path.join(stateDir, "uploads", "sticker.gif")
  fs.mkdirSync(path.dirname(stickerPath), { recursive: true })
  fs.writeFileSync(stickerPath, Buffer.from("test-sticker"))
  const harness = createAttachmentHarness({ stateDir })

  await harness.service.handleWebChatMessages({
    messages: [{
      messageId: "message-sticker",
      text: "",
      attachments: [{
        kind: "sticker",
        absolutePath: stickerPath,
        fileName: "sticker.gif",
        contentType: "image/gif",
      }],
    }],
  })

  assert.equal(harness.routeCalls.length, 1)
  assert.deepEqual(
    pickAttachmentFields(harness.routeCalls[0].prepared.attachments[0]),
    {
      kind: "sticker",
      fileName: "sticker.gif",
      contentType: "image/gif",
      relativePath: "uploads/sticker.gif",
    },
  )
  assert.ok(harness.pathValidationCalls.length >= 1)
})

test("murmurlane chat service validates an attachment inside a bubble segment", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-chat-segment-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const imagePath = path.join(stateDir, "uploads", "segment.png")
  fs.mkdirSync(path.dirname(imagePath), { recursive: true })
  fs.writeFileSync(imagePath, Buffer.from("segment-image"))
  const harness = createAttachmentHarness({ stateDir })

  await harness.service.handleWebChatMessages({
    messages: [{
      messageId: "message-segment",
      text: "",
      bubbleSegments: [{
        segmentId: "segment-1",
        text: "",
        attachments: [{
          kind: "image",
          absolutePath: imagePath,
          fileName: "segment.png",
          contentType: "image/png",
        }],
      }],
    }],
  })

  assert.equal(harness.routeCalls.length, 1)
  const prepared = harness.routeCalls[0].prepared
  const segmentAttachment = prepared.sourceMessages[0].bubbleSegments[0].attachments[0]
  assert.equal(segmentAttachment.absolutePath, path.resolve(imagePath))
  assert.equal(segmentAttachment.relativePath, "uploads/segment.png")
  assert.ok(harness.pathValidationCalls.some((call) => call.candidate === path.resolve(imagePath)))
})

test("murmurlane chat service rejects an attachment outside the state directory", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-chat-root-"))
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-chat-outside-"))
  t.after(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })
  const outsidePath = path.join(outsideDir, "outside.txt")
  fs.writeFileSync(outsidePath, "outside")
  const harness = createAttachmentHarness({ stateDir })

  await assert.rejects(
    () => harness.service.handleWebChatMessages({
      messages: [{
        messageId: "message-outside",
        text: "",
        attachments: [{
          kind: "file",
          absolutePath: outsidePath,
          fileName: "outside.txt",
          contentType: "text/plain",
        }],
      }],
    }),
    { message: "web attachment path is outside the Cyberboss state directory" },
  )

  assert.equal(harness.routeCalls.length, 0)
  assert.ok(harness.pathValidationCalls.some((call) => call.candidate === path.resolve(outsidePath)))
})

test("murmurlane chat service keeps a link attachment without local path validation", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-chat-link-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const harness = createAttachmentHarness({ stateDir })

  await harness.service.handleWebChatMessages({
    messages: [{
      messageId: "message-link",
      text: "",
      attachments: [{
        kind: "link",
        url: "https://example.com/file",
      }],
    }],
  })

  assert.equal(harness.routeCalls.length, 1)
  assert.deepEqual(harness.routeCalls[0].prepared.attachments[0], {
    kind: "link",
    url: "https://example.com/file",
    path: "https://example.com/file",
    absolutePath: "https://example.com/file",
    fileName: "https://example.com/file",
    contentType: "text/uri-list",
  })
  assert.equal(harness.pathValidationCalls.length, 0)
})

for (const [activeRuntimeId, targetRuntimeId] of [
  ["claudecode", "codex"],
  ["codex", "claudecode"],
]) {
  test(`murmurlane rejects a ${targetRuntimeId} thread while ${activeRuntimeId} is active`, async (t) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-chat-runtime-owner-"))
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
    const sessionsFile = path.join(stateDir, "sessions.json")
    const workspaceRoot = normalizeWorkspaceRoot(stateDir)
    const bindingKey = "workspace-1:account-1:user-1"
    const targetThreadId = `thread-${targetRuntimeId}`
    new SessionStore({ filePath: sessionsFile, runtimeId: targetRuntimeId })
      .setThreadIdForWorkspace(bindingKey, workspaceRoot, targetThreadId)
    const sessionStore = new SessionStore({
      filePath: sessionsFile,
      runtimeId: activeRuntimeId,
    })
    const resumeCalls = []
    const routeCalls = []
    const service = createMurmurLaneChatService({
      config: {
        stateDir,
        workspaceId: "workspace-1",
        workspaceRoot,
        accountId: "account-1",
        webChatSenderId: "user-1",
        webChatEnabled: true,
      },
      adapter: {
        getClientCount() { return 0 },
        getEventCursor() { return 0 },
        setActiveTarget() {},
        publish() {},
      },
      cyberbossPort: {
        resolveWeixinAccount() { return null },
        getActiveAccountId() { return "account-1" },
        getRuntimeAdapter() {
          return {
            getSessionStore() { return sessionStore },
            describe() { return { id: activeRuntimeId } },
            async resumeThread(args) {
              resumeCalls.push(args)
              return { threadId: args.threadId }
            },
          }
        },
        getThreadStateStore() {
          return {
            getThreadState() { return null },
            getLatestContext() { return null },
          }
        },
        resolveWorkspaceRoot() { return workspaceRoot },
        async routePreparedInbound(payload) {
          routeCalls.push(payload)
          return { accepted: true, threadId: targetThreadId, turnId: "wrong-runtime-turn" }
        },
        findModelByQuery() { return null },
        isPathWithinRoot() { return true },
        buildInboundDraft,
        buildMergedInboundPrepared,
        normalizeWorkspaceRoot,
      },
    })

    const result = await service.handleWebChatMessages({
      clientId: "client-runtime-mismatch",
      threadId: targetThreadId,
      requestId: `request-${activeRuntimeId}-${targetRuntimeId}`,
      messageId: `message-${activeRuntimeId}-${targetRuntimeId}`,
      messages: [{
        messageId: `message-${activeRuntimeId}-${targetRuntimeId}`,
        text: "do not send this to the wrong runtime",
      }],
    })

    assert.equal(result.accepted, false)
    assert.equal(result.status, "failed")
    assert.equal(result.threadId, targetThreadId)
    assert.equal(resumeCalls.length, 0)
    assert.equal(routeCalls.length, 0)
  })
}

function createAttachmentHarness({ stateDir }) {
  const routeCalls = []
  const pathValidationCalls = []
  const sessionStore = {
    buildBindingKey() { return "workspace-1:account-1:user-1" },
    getThreadIdForWorkspace() { return "thread-1" },
    getRuntimeParamsForWorkspace() { return {} },
  }
  const service = createMurmurLaneChatService({
    config: {
      stateDir,
      workspaceId: "workspace-1",
      workspaceRoot: stateDir,
      accountId: "account-1",
      webChatSenderId: "user-1",
      webChatEnabled: true,
    },
    adapter: {
      getClientCount() { return 0 },
      getEventCursor() { return 0 },
      setActiveTarget() {},
    },
    cyberbossPort: {
      resolveWeixinAccount() { return null },
      getActiveAccountId() { return "account-1" },
      getRuntimeAdapter() {
        return {
          getSessionStore() { return sessionStore },
          describe() { return { id: "codex" } },
        }
      },
      getThreadStateStore() {
        return {
          getThreadState() { return null },
          getLatestContext() { return null },
        }
      },
      resolveWorkspaceRoot() { return stateDir },
      async routePreparedInbound(payload) {
        routeCalls.push(payload)
        return { accepted: true, threadId: "thread-1", turnId: "turn-1" }
      },
      findModelByQuery() { return null },
      isPathWithinRoot(candidate, root) {
        pathValidationCalls.push({ candidate, root })
        return isPathWithinRoot(candidate, root)
      },
      buildInboundDraft,
      buildMergedInboundPrepared,
      normalizeWorkspaceRoot,
    },
  })
  return { service, routeCalls, pathValidationCalls }
}

function createThreadDeleteHarness({ threadState = null } = {}) {
  const deleteCalls = []
  const service = createMurmurLaneChatService({
    config: {
      workspaceId: "workspace-1",
      workspaceRoot: "D:\\study\\cyberboss",
      accountId: "account-1",
      webChatSenderId: "user-1",
      webChatEnabled: true,
    },
    adapter: {
      getClientCount() { return 0 },
      getEventCursor() { return 0 },
    },
    cyberbossPort: {
      resolveWeixinAccount() { return null },
      getActiveAccountId() { return "account-1" },
      getRuntimeAdapter() {
        return {
          getSessionStore() {
            return {
              buildBindingKey() { return "workspace-1:account-1:user-1" },
              getThreadIdForWorkspace() { return "" },
              getRuntimeParamsForWorkspace() { return {} },
            }
          },
          describe() { return { id: "codex" } },
        }
      },
      getThreadStateStore() {
        return {
          getThreadState() { return threadState },
          getLatestContext() { return null },
        }
      },
      resolveWorkspaceRoot() { return "D:/study/cyberboss" },
      async routePreparedInbound() { return { accepted: true } },
      findModelByQuery() { return null },
      isPathWithinRoot() { return true },
      buildInboundDraft(value) { return value },
      buildMergedInboundPrepared(value) { return value },
      normalizeWorkspaceRoot(value) { return String(value || "").replace(/\\/g, "/") },
    },
    conversationCommands: {
      async deleteThreadRecords(input) {
        deleteCalls.push(input)
        return {
          threadId: input.threadId,
          deletedRecordCount: 2,
          touchedDates: ["2026-07-30"],
          deletedSourceKeys: ["codex|file|1"],
        }
      },
    },
  })
  return { service, deleteCalls }
}

function pickAttachmentFields(attachment) {
  return {
    kind: attachment.kind,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    relativePath: attachment.relativePath,
  }
}
