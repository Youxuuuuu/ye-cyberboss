const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { createWebChatServer } = require("../src/custom/xiaoye/murmurlane/webchat/server")

test("POST /api/chat/messages dispatches the same requestId once", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-idempotency-"))
  let dispatchCount = 0
  const chatService = {
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
    chatService,
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

test("DELETE /api/chat/thread/:threadId delegates the authenticated online delete command", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-thread-delete-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const calls = []
  const server = createWebChatServer({
    config: {
      stateDir,
      webChatEnabled: true,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
      webChatAllowedOrigins: [],
    },
    chatService: {
      getWebChatIdentity() { return null },
      async deleteWebChatThread(input) {
        calls.push(input)
        return {
          threadId: input.threadId,
          deletedRecordCount: 3,
          touchedDates: ["2026-07-31"],
          deletedSourceKeys: ["source-a", "source-b", "source-c"],
        }
      },
    },
    adapter: { getClientCount() { return 0 } },
  })
  await server.start()
  t.after(() => server.close())
  const address = server.address()

  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/chat/thread/${encodeURIComponent("thread-delete")}`,
    { method: "DELETE" },
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    threadId: "thread-delete",
    deletedRecordCount: 3,
    touchedDates: ["2026-07-31"],
    deletedSourceKeys: ["source-a", "source-b", "source-c"],
  })
  assert.deepEqual(calls, [{ threadId: "thread-delete" }])
})

test("POST /api/chat/effort delegates the workspace runtime setting command", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-effort-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const calls = []
  const server = createWebChatServer({
    config: {
      stateDir,
      webChatEnabled: true,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
      webChatAllowedOrigins: [],
    },
    chatService: {
      getWebChatIdentity() { return { senderId: "user-1" } },
      async setWebChatEffort(input) {
        calls.push(input)
        return { effort: input.effort, runtimeId: "codex" }
      },
    },
    adapter: { getClientCount() { return 0 } },
  })
  await server.start()
  t.after(() => server.close())
  const address = server.address()

  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/effort`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ effort: "high" }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { effort: "high", runtimeId: "codex" })
  assert.deepEqual(calls, [{ senderId: "user-1", effort: "high" }])
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
    chatService: {
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

test("POST /api/chat/voice-messages dispatches one binary voice command per requestId", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-voice-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const commands = []
  const server = createWebChatServer({
    config: {
      stateDir,
      webChatEnabled: true,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
      webChatAllowedOrigins: [],
    },
    chatService: {
      getWebChatIdentity() { return { senderId: "user-voice" } },
      async handleWebChatVoiceMessage(input) {
        commands.push(input)
        return { accepted: true, requestId: input.requestId, messageId: input.messageId, threadId: input.threadId }
      },
    },
    adapter: { getClientCount() { return 0 } },
  })
  await server.start()
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/chat/voice-messages`
  const send = () => fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "audio/webm;codecs=opus",
      "X-Cyberboss-Request-Id": "request-voice-1",
      "X-Cyberboss-Message-Id": "message-voice-1",
      "X-Cyberboss-Thread-Id": "thread-voice-1",
      "X-Cyberboss-Client-Id": "client-voice-1",
    },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]),
  }).then(async (response) => ({ status: response.status, body: await response.json() }))

  const first = await send()
  const replay = await send()

  assert.equal(first.status, 202)
  assert.equal(first.body.deduplicated, false)
  assert.equal(replay.body.deduplicated, true)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].contentType, "audio/webm;codecs=opus")
  assert.equal(commands[0].bytes[0], 0x1a)
})

test("POST /api/chat/voice-messages applies the workflow deadline while the upload is still open", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-voice-deadline-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const server = createWebChatServer({
    config: {
      stateDir,
      webChatEnabled: true,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
      webChatAllowedOrigins: [],
      userVoiceWorkflowTimeoutMs: 20,
    },
    chatService: {
      getWebChatIdentity() { return { senderId: "user-voice" } },
      async handleWebChatVoiceMessage() { throw new Error("must not dispatch an incomplete upload") },
    },
    adapter: { getClientCount() { return 0 } },
  })
  await server.start()
  t.after(() => server.close())

  const result = await new Promise((resolve, reject) => {
    const request = require("node:http").request({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/api/chat/voice-messages",
      method: "POST",
      headers: {
        "Content-Type": "audio/webm",
        "X-Cyberboss-Request-Id": "request-voice-timeout",
        "X-Cyberboss-Message-Id": "message-voice-timeout",
        "X-Cyberboss-Client-Id": "client-voice-timeout",
      },
    }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }))
    })
    request.on("error", reject)
    request.write(Buffer.from([0x1a]))
    request.flushHeaders()
  })

  assert.equal(result.status, 504)
  assert.equal(result.body.reason, "provider-timeout")
})

test("voice retry and transcript confirmation use dedicated idempotent action commands", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-voice-actions-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const retries = []
  const confirmations = []
  const server = createWebChatServer({
    config: {
      stateDir,
      webChatEnabled: true,
      webChatHost: "127.0.0.1",
      webChatPort: 0,
      webChatAllowedOrigins: [],
    },
    chatService: {
      getWebChatIdentity() { return { senderId: "user-voice" } },
      async handleWebChatVoiceRetry(input) {
        retries.push(input)
        return { accepted: true, messageId: input.messageId }
      },
      async handleWebChatVoiceTranscriptConfirm(input) {
        confirmations.push(input)
        return { accepted: true, messageId: input.messageId }
      },
    },
    adapter: { getClientCount() { return 0 } },
  })
  await server.start()
  t.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/chat/voice-messages/${encodeURIComponent("voice/message 1")}`
  const send = (action, body) => fetch(`${baseUrl}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }))

  const retry = await send("retry", { requestId: "voice-action-retry-1", clientId: "client-1" })
  const retryReplay = await send("retry", { requestId: "voice-action-retry-1", clientId: "client-1" })
  const confirmation = await send("transcript", {
    requestId: "voice-action-confirm-1",
    clientId: "client-1",
    normalizedText: "  修正后的文字。  ",
  })

  assert.equal(retry.status, 202)
  assert.equal(retry.body.deduplicated, false)
  assert.equal(retryReplay.body.deduplicated, true)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].messageId, "voice/message 1")
  assert.equal(confirmations.length, 1)
  assert.equal(confirmations[0].normalizedText, "修正后的文字。")
  assert.equal(confirmation.body.deduplicated, false)
})

test("Assistant voice and Speech Rendition endpoints keep action idempotency", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchat-server-assistant-voice-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const calls = []
  const chatService = {
    getWebChatIdentity() { return { senderId: "user-1" } },
    async handleWebChatAssistantVoice(input) {
      calls.push(["voice", input])
      return { accepted: true, kind: "delivered", messageId: input.messageId }
    },
    async handleWebChatAssistantVoiceRetry(input) {
      calls.push(["retry", input])
      return { accepted: true, kind: "delivered", messageId: input.messageId }
    },
    async handleWebChatSpeechRendition(input) {
      calls.push(["rendition", input])
      return { rendition: { schemaVersion: 1, status: "ready", activeGenerationId: "generation-1" } }
    },
  }
  const server = createWebChatServer({
    config: { stateDir, webChatEnabled: true, webChatHost: "127.0.0.1", webChatPort: 0, webChatAllowedOrigins: [] },
    chatService,
    adapter: { getClientCount() { return 0 } },
  })
  await server.start()
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (pathName, body) => fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json())

  const voiceBody = { requestId: "assistant-request-1", messageId: "assistant-message-1", spokenText: "你好", threadId: "thread-1" }
  const first = await send("/api/chat/assistant-voice", voiceBody)
  const replay = await send("/api/chat/assistant-voice", voiceBody)
  assert.equal(first.deduplicated, false)
  assert.equal(replay.deduplicated, true)
  assert.equal(calls.filter(([kind]) => kind === "voice").length, 1)

  await send("/api/chat/assistant-voice/assistant-message-1/retry", { requestId: "assistant-retry-1", useCurrentProfile: false })
  await send("/api/chat/speech-renditions/assistant-message-1", { requestId: "assistant-rendition-1" })
  assert.deepEqual(calls.map(([kind]) => kind), ["voice", "retry", "rendition"])
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
    chatService: {
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
