const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { createWebChatServer } = require("../src/custom/xiaoye/murmurlane/webchat/server")

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

test("POST /api/chat/uploads streams binary bytes and rejects oversized bodies", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-upload-"))
  const uploads = []
  const server = createWebChatServer({
    config: {
      stateDir,
      webChatEnabled: true,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
      webChatAllowedOrigins: [],
      webChatMaxUploadBytes: 8,
    },
    app: {
      getWebChatIdentity() { return { senderId: "user-1" } },
    },
    adapter: {
      getClientCount() { return 0 },
      async persistUpload(input) {
        uploads.push(input)
        return { kind: input.kind, fileName: input.fileName, sizeBytes: input.bytes.length }
      },
    },
  })
  await server.start()
  t.after(() => server.close())
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/api/chat/uploads`

  const accepted = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-Cyberboss-File-Name": encodeURIComponent("小诗.txt"),
      "X-Cyberboss-Media-Kind": "file",
    },
    body: Buffer.from("hello", "utf8"),
  })
  assert.equal(accepted.status, 201)
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].bytes.toString("utf8"), "hello")
  assert.equal(uploads[0].fileName, "小诗.txt")
  assert.equal(uploads[0].contentType, "text/plain")
  assert.equal(uploads[0].kind, "file")

  const rejected = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Cyberboss-File-Name": "large.bin",
      "X-Cyberboss-Media-Kind": "file",
    },
    body: Buffer.alloc(9, 1),
  })
  assert.equal(rejected.status, 413)
  assert.equal(uploads.length, 1)
})

test("GET /api/chat/media accepts query authentication for browser assets", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-media-auth-"))
  const mediaPath = path.join(stateDir, "inbox", "photo.jpg")
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  fs.writeFileSync(mediaPath, "image-bytes", "utf8")
  const server = createWebChatServer({
    config: {
      stateDir,
      webChatEnabled: true,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
      webChatAllowedOrigins: [],
      webChatToken: "asset-secret",
    },
    app: {
      getWebChatIdentity() { return { senderId: "user-1" } },
    },
    adapter: { getClientCount() { return 0 } },
  })
  await server.start()
  t.after(() => server.close())
  const address = server.address()
  const mediaQuery = `path=${encodeURIComponent(mediaPath)}`
  const baseUrl = `http://127.0.0.1:${address.port}/api/chat/media?${mediaQuery}`

  const anonymous = await fetch(baseUrl)
  assert.equal(anonymous.status, 401)

  const authenticated = await fetch(`${baseUrl}&token=${encodeURIComponent("asset-secret")}`)
  assert.equal(authenticated.status, 200)
  assert.equal(authenticated.headers.get("Cache-Control"), "private, max-age=3600")
  assert.equal(await authenticated.text(), "image-bytes")
})
