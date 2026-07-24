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
    getWebChatIdentity() {
      return { senderId: "user-1" }
    },
    getWebChatStatus() {
      return { connected: true }
    },
    async getWebChatModels() {
      return { models: [] }
    },
    async setWebChatModel() {
      return { connected: true }
    },
    async selectWebChatThread() {
      return { connected: true }
    },
    async handleWebChatMessages() {
      return { accepted: true }
    },
  }
}
