const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { WebChatRequestLedger } = require("../src/custom/xiaoye/murmurlane/webchat/request-ledger")

test("concurrent and completed retries dispatch a request only once", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-request-ledger-"))
  const ledger = new WebChatRequestLedger({ filePath: path.join(stateDir, "requests.json") })
  let dispatchCount = 0
  let release
  const run = () => {
    dispatchCount += 1
    return new Promise((resolve) => { release = resolve })
  }

  const first = ledger.execute({ requestId: "request-1", fingerprint: "fingerprint-1", run })
  const duplicate = ledger.execute({ requestId: "request-1", fingerprint: "fingerprint-1", run })
  assert.equal(dispatchCount, 1)
  release({ accepted: true, threadId: "thread-1" })

  assert.equal((await first).deduplicated, false)
  assert.equal((await duplicate).deduplicated, true)
  const replay = await ledger.execute({ requestId: "request-1", fingerprint: "fingerprint-1", run })
  assert.equal(replay.deduplicated, true)
  assert.equal(dispatchCount, 1)
})

test("the same requestId cannot be reused with different content", async () => {
  const ledger = new WebChatRequestLedger()
  await ledger.execute({
    requestId: "request-conflict",
    fingerprint: "fingerprint-a",
    run: async () => ({ accepted: true }),
  })
  await assert.rejects(
    ledger.execute({
      requestId: "request-conflict",
      fingerprint: "fingerprint-b",
      run: async () => ({ accepted: true }),
    }),
    /different payload/,
  )
})
