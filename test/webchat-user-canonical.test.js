const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { createXiaoyeModules } = require("../src/custom/xiaoye")

test("xiaoye modules archive and publish one merged web user", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-xiaoye-inbound-"))
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
  const prepared = {
    provider: "web",
    requestId: "request-1",
    messageId: "message-1",
    logicalTurnId: "web:request-1",
    originalText: "first\n\nsecond\n\nthird",
    bubbleSegments: [
      { segmentId: "segment-a", text: "first" },
      { segmentId: "segment-b", text: "second" },
      { segmentId: "segment-c", text: "third" },
    ],
    sourceMessages: [
      { messageId: "legacy-a", text: "first" },
      { messageId: "legacy-b", text: "second" },
      { messageId: "legacy-c", text: "third" },
    ],
  }

  const result = modules.recordInbound(prepared, {
    runtimeId: "claudecode",
    threadId: "thread-1",
    turnId: "transport-1",
  })

  assert.equal(result.writtenCount, 1)
  const published = modules.murmurlane.adapter
    .getRecentEvents(0)
    .filter((event) => event.kind === "message")
  assert.equal(published.length, 1)
  assert.equal(published[0].record.messageId, "message-1")
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
