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

function createFakeCyberbossPort() {
  return {
    resolveWeixinAccount() { return null },
    getActiveAccountId() { return "" },
    getRuntimeAdapter() { return {} },
    getThreadStateStore() { return {} },
    resolveWorkspaceRoot() { return "" },
    async routePreparedInbound() { return null },
    findModelByQuery() { return null },
    isPathWithinRoot() { return true },
    buildInboundDraft(value) { return value },
    buildMergedInboundPrepared(value) { return value },
    normalizeWorkspaceRoot(value) { return value || "" },
  }
}
