const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { createWebChatServer } = require("../src/adapters/channel/webchat/server")

test("POST /api/chat/messages dispatches the same requestId once", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-idempotency-"))
  let dispatchCount = 0
  const app = {
    getWebChatIdentity() { return { senderId: "user-1" } },
    async handleWebChatMessages(input) {
      dispatchCount += 1
      return {
        accepted: true,
        requestId: input.requestId,
        messageId: input.messageId,
        threadId: "thread-1",
      }
    },
  }
  const server = createWebChatServer({
    config: {
      stateDir,
      webChatEnabled: true,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
      webChatAllowedOrigins: [],
    },
    app,
    adapter: { getClientCount() { return 0 } },
  })
  await server.start()
  t.after(() => server.close())
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/api/chat/messages`
  const body = JSON.stringify({
    requestId: "request-http-1",
    messageId: "message-http-1",
    clientId: "client-http-1",
    messages: [{
      messageId: "message-http-1",
      text: "hello",
      receivedAt: "2026-07-18T00:00:00.000Z",
      bubbleSegments: [{ segmentId: "segment-http-1", text: "hello" }],
    }],
  })
  const send = () => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).then((response) => response.json())

  const first = await send()
  const replay = await send()
  assert.equal(first.deduplicated, false)
  assert.equal(replay.deduplicated, true)
  assert.equal(dispatchCount, 1)
})
