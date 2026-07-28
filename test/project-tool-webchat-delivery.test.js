const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { createWebChatChannelAdapter } = require("../src/custom/xiaoye/murmurlane/webchat")
const { createWebChatServer } = require("../src/custom/xiaoye/murmurlane/webchat/server")
const { createXiaoyeProjectTooling } = require("../src/custom/xiaoye")
const { RuntimeContextStore } = require("../src/tools/runtime-context-store")

test("standalone project tools deliver a WebChat file through the running channel", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-project-tool-webchat-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  const filePath = path.join(stateDir, "inbox", "fixture.txt")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, "fixture", "utf8")

  const config = createConfig(stateDir)
  const webAdapter = createWebChatChannelAdapter({ config })
  const webServer = createWebChatServer({
    config,
    adapter: webAdapter,
    chatService: {
      getWebChatIdentity() {
        return { senderId: "user-web" }
      },
    },
  })
  await webServer.start()
  t.after(() => webServer.close())
  config.webChatPort = webServer.address().port
  const eventsUrl = `http://127.0.0.1:${config.webChatPort}/api/chat/events?threadId=thread-web&after=0`

  const { toolHost } = createXiaoyeProjectTooling(config)
  const cyberbossProcessStore = new RuntimeContextStore({
    filePath: config.projectToolContextFile,
  })
  cyberbossProcessStore.setActiveContext({
    workspaceRoot: "D:/study/cyberboss",
    runtimeId: "codex",
    threadId: "thread-web",
    senderId: "user-web",
    provider: "web",
  })

  await toolHost.invokeTool("cyberboss_channel_send_file", {
    filePath,
  }, {
    workspaceRoot: "D:/study/cyberboss",
    runtimeId: "codex",
  })

  const message = await readFirstMessageEvent(eventsUrl, config.webChatToken)
  assert.equal(message?.threadId, "thread-web")
  assert.equal(message?.record?.meta?.files?.[0]?.fileName, "fixture.txt")
  assert.equal(message?.record?.meta?.files?.[0]?.relativePath, "inbox/fixture.txt")
  assert.equal(message?.record?.meta?.files?.[0]?.contentType, "text/plain")
})

for (const runtimeId of ["codex", "claudecode"]) {
  test(`${runtimeId} standalone project tools deliver image and sticker WebChat events`, async (t) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-project-tool-media-"))
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

    const imagePath = path.join(stateDir, "inbox", "fixture.png")
    const stickerPath = path.join(stateDir, "stickers", "assets", "stk_001.gif")
    fs.mkdirSync(path.dirname(imagePath), { recursive: true })
    fs.mkdirSync(path.dirname(stickerPath), { recursive: true })
    fs.writeFileSync(imagePath, "image", "utf8")
    fs.writeFileSync(stickerPath, "sticker", "utf8")
    fs.writeFileSync(path.join(stateDir, "stickers", "index.json"), JSON.stringify({
      stk_001: {
        tags: ["fixture"],
        desc: "fixture sticker",
      },
    }), "utf8")
    fs.writeFileSync(path.join(stateDir, "stickers", "tags.json"), "[]", "utf8")

    const config = createConfig(stateDir)
    config.runtime = runtimeId
    const webAdapter = createWebChatChannelAdapter({ config })
    const webServer = createWebChatServer({
      config,
      adapter: webAdapter,
      chatService: {
        getWebChatIdentity() {
          return { senderId: "user-web" }
        },
      },
    })
    await webServer.start()
    t.after(() => webServer.close())
    config.webChatPort = webServer.address().port
    const eventsUrl = `http://127.0.0.1:${config.webChatPort}/api/chat/events?threadId=thread-web&after=0`

    const { toolHost } = createXiaoyeProjectTooling(config)
    const cyberbossProcessStore = new RuntimeContextStore({
      filePath: config.projectToolContextFile,
    })
    cyberbossProcessStore.setActiveContext({
      workspaceRoot: "D:/study/cyberboss",
      runtimeId,
      threadId: "thread-web",
      senderId: "user-web",
      provider: "web",
    })

    await toolHost.invokeTool("cyberboss_channel_send_file", {
      filePath: imagePath,
    }, {
      workspaceRoot: "D:/study/cyberboss",
      runtimeId,
    })
    await toolHost.invokeTool("cyberboss_sticker_send", {
      stickerId: "stk_001",
    }, {
      workspaceRoot: "D:/study/cyberboss",
      runtimeId,
    })

    const messages = await readMessageEvents(eventsUrl, config.webChatToken, 2)
    assert.equal(messages[0]?.record?.meta?.attachments?.[0]?.kind, "image")
    assert.equal(messages[1]?.record?.meta?.stickers?.[0]?.stickerId, "stk_001")
    assert.equal(
      messages[1]?.record?.meta?.stickers?.[0]?.relativePath,
      "stickers/assets/stk_001.gif",
    )
  })
}

test("internal WebChat tool delivery rejects files outside the state directory", async (t) => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-project-tool-security-"))
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true }))
  const stateDir = path.join(testRoot, "state")
  const outsidePath = path.join(testRoot, "outside.txt")
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(outsidePath, "outside", "utf8")

  const config = createConfig(stateDir)
  const webAdapter = createWebChatChannelAdapter({ config })
  const webServer = createWebChatServer({
    config,
    adapter: webAdapter,
    chatService: {
      getWebChatIdentity() {
        return { senderId: "user-web" }
      },
    },
  })
  await webServer.start()
  t.after(() => webServer.close())
  const response = await fetch(
    `http://127.0.0.1:${webServer.address().port}/api/chat/internal/file-deliveries`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.webChatToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-web",
        threadId: "thread-web",
        filePath: outsidePath,
      }),
    },
  )

  assert.equal(response.status, 403)
  assert.deepEqual(webAdapter.getRecentEvents(0), [])
})

function readFirstMessageEvent(url, token) {
  return readMessageEvents(url, token, 1).then((events) => events[0])
}

function readMessageEvents(url, token, count) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    let buffer = ""
    const messages = []
    const timer = setTimeout(() => {
      request.destroy()
      reject(new Error("timed out waiting for a WebChat message event"))
    }, 2_000)
    request.on("response", (response) => {
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        buffer += chunk
        const blocks = buffer.split("\n\n")
        buffer = blocks.pop() || ""
        for (const block of blocks) {
          const data = block.split("\n")
            .find((line) => line.startsWith("data: "))
          if (!data) continue
          const event = JSON.parse(data.slice(6))
          if (event.kind !== "message") continue
          messages.push(event)
          if (messages.length < count) continue
          clearTimeout(timer)
          request.destroy()
          resolve(messages)
          return
        }
      })
    })
    request.on("error", (error) => {
      if (error.code !== "ECONNRESET") {
        clearTimeout(timer)
        reject(error)
      }
    })
  })
}

function createConfig(stateDir) {
  return {
    stateDir,
    runtime: "codex",
    workspaceRoot: "D:/study/cyberboss",
    sessionsFile: path.join(stateDir, "sessions.json"),
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    webChatEnabled: true,
    webChatHost: "127.0.0.1",
    webChatPort: 0,
    webChatToken: "fixture-web-token",
    webChatSenderId: "user-web",
    webChatAllowedOrigins: [],
    webChatRequestLedgerFile: path.join(stateDir, "webchat-request-ledger.json"),
    allowedUserIds: ["user-web"],
    accountsDir: path.join(stateDir, "accounts"),
    accountId: "",
    weixinBaseUrl: "http://127.0.0.1:1",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    stickersDir: path.join(stateDir, "stickers"),
    stickerAssetsDir: path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: path.join(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: path.join(stateDir, "templates", "stickers"),
    stickersTemplateIndexFile: path.join(stateDir, "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.join(stateDir, "templates", "stickers", "tags.json"),
    diaryDir: path.join(stateDir, "diary"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    locationStoreFile: path.join(stateDir, "locations.json"),
  }
}
