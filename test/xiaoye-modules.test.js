const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { createXiaoyeModules } = require("../src/custom/xiaoye")

test("xiaoye composition root exposes conversation and murmurlane lifecycle", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-xiaoye-modules-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  const modules = createXiaoyeModules({
    config: {
      stateDir,
      conversationDir: path.join(stateDir, "conversations"),
      webChatEnabled: false,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
    },
    cyberbossPort: createFakeCyberbossPort(),
  })

  assert.ok(modules.conversation)
  assert.ok(modules.murmurlane.adapter)
  assert.ok(modules.murmurlane.server)
  assert.ok(modules.murmurlane.chatService)

  await modules.start()
  await modules.close()
})

test("xiaoye composition root rejects a missing required murmurlane port", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-xiaoye-port-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const cyberbossPort = createFakeCyberbossPort()
  delete cyberbossPort.getRuntimeSettings

  assert.throws(
    () => createXiaoyeModules({
      config: {
        stateDir,
        conversationDir: path.join(stateDir, "conversations"),
        webChatEnabled: false,
        webChatHost: "127.0.0.1",
        webChatPort: 0,
      },
      cyberbossPort,
    }),
    { message: "xiaoye cyberbossPort.getRuntimeSettings is required" },
  )
})

test("xiaoye composition root routes web thread deletion to its conversation archive", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-xiaoye-delete-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const conversationDir = path.join(stateDir, "conversations")
  const dayFile = path.join(conversationDir, "2026-07-30.jsonl")
  const threadStateStore = {
    getThreadState() { return { status: "idle" } },
    getLatestContext() { return null },
  }
  const sessionStore = {
    buildBindingKey() { return "workspace-1:account-1:user-1" },
    getThreadIdForWorkspace() { return "" },
    getRuntimeParamsForWorkspace() { return {} },
  }
  const modules = createXiaoyeModules({
    config: {
      stateDir,
      conversationDir,
      workspaceId: "workspace-1",
      workspaceRoot: stateDir,
      accountId: "account-1",
      webChatSenderId: "user-1",
      webChatEnabled: false,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
    },
    cyberbossPort: {
      ...createFakeCyberbossPort(),
      getRuntimeAdapter() {
        return {
          getSessionStore() { return sessionStore },
          describe() { return { id: "codex" } },
        }
      },
      getThreadStateStore() { return threadStateStore },
      resolveWorkspaceRoot() { return stateDir },
    },
  })
  modules.conversation.writer.writeRecords([
    {
      type: "user",
      timestamp: "2026-07-30T08:00:00.000Z",
      runtimeId: "codex",
      threadId: "thread-delete",
      text: "delete",
      source: {
        provider: "codex",
        sourceType: "response_item",
        rawId: "delete-1",
        sourceKey: "codex|delete|1",
      },
    },
    {
      type: "user",
      timestamp: "2026-07-30T08:01:00.000Z",
      runtimeId: "codex",
      threadId: "thread-keep",
      text: "keep",
      source: {
        provider: "codex",
        sourceType: "response_item",
        rawId: "keep-1",
        sourceKey: "codex|keep|1",
      },
    },
  ])

  const result = await modules.murmurlane.chatService.deleteWebChatThread({
    senderId: "user-1",
    threadId: "thread-delete",
  })

  assert.equal(result.deletedRecordCount, 1)
  assert.deepEqual(
    fs.readFileSync(dayFile, "utf8").trim().split("\n").map((line) => JSON.parse(line).threadId),
    ["thread-keep"],
  )
  await modules.close()
})

function createFakeCyberbossPort() {
  return {
    resolveWeixinAccount() { return null },
    getActiveAccountId() { return "" },
    getRuntimeAdapter() { return {} },
    getThreadStateStore() { return {} },
    getThreadUsageTotals() { return null },
    deleteThreadUsage() { return false },
    async getRuntimeSettings() { return {} },
    async updateRuntimeSettings() { return {} },
    resolveWorkspaceRoot() { return "" },
    async routePreparedInbound() { return null },
    isPathWithinRoot() { return true },
    buildInboundDraft(value) { return value },
    buildMergedInboundPrepared(value) { return value },
    normalizeWorkspaceRoot(value) { return value || "" },
  }
}
