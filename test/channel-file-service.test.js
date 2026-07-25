const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { saveWeixinAccount } = require("../src/adapters/channel/weixin/account-store")
const { persistContextToken } = require("../src/adapters/channel/weixin/context-token-store")
const { ChannelFileService } = require("../src/services/channel-file-service")

test("current-chat file delivery uses the explicit web provider without a Weixin fallback", async (t) => {
  const fixture = createFixture(t)
  const sent = []
  const service = new ChannelFileService({
    config: fixture.config,
    channelAdapter: createChannelAdapter(sent),
    sessionStore: { state: { bindings: {} } },
  })

  const result = await service.sendToCurrentChat({
    filePath: fixture.filePath,
  }, {
    provider: "web",
    senderId: "web-user",
    threadId: "web-thread",
  })

  assert.equal(result.userId, "web-user")
  assert.deepEqual(sent.filter((entry) => entry.kind === "file"), [{
    kind: "file",
    provider: "web",
    userId: "web-user",
    threadId: "web-thread",
    contextToken: "",
    filePath: path.resolve(fixture.filePath),
  }])
})

test("current-chat file delivery keeps the Weixin account and token path", async (t) => {
  const fixture = createFixture(t)
  saveWeixinAccount(fixture.config, "wx-account", {
    token: "account-token",
    baseUrl: fixture.config.weixinBaseUrl,
    userId: "bot-user",
  })
  persistContextToken(fixture.config, "wx-account", "wx-user", "wx-context-token")
  const sent = []
  const service = new ChannelFileService({
    config: {
      ...fixture.config,
      accountId: "wx-account",
    },
    channelAdapter: createChannelAdapter(sent),
    sessionStore: { state: { bindings: {} } },
  })

  await service.sendToCurrentChat({
    filePath: fixture.filePath,
  }, {
    provider: "weixin",
    senderId: "wx-user",
    threadId: "wx-thread",
  })

  assert.deepEqual(sent.filter((entry) => entry.kind === "file"), [{
    kind: "file",
    provider: "weixin",
    userId: "wx-user",
    threadId: "wx-thread",
    contextToken: "wx-context-token",
    filePath: path.resolve(fixture.filePath),
  }])
})

function createFixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-channel-file-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const filePath = path.join(stateDir, "fixture.txt")
  fs.writeFileSync(filePath, "fixture", "utf8")
  return {
    filePath,
    config: {
      stateDir,
      accountsDir: path.join(stateDir, "accounts"),
      weixinBaseUrl: "https://ilinkai.weixin.qq.com",
      workspaceId: "default",
      allowedUserIds: [],
    },
  }
}

function createChannelAdapter(sent) {
  return {
    getWebReplyTarget() {
      return null
    },
    async sendTyping(payload) {
      sent.push({ kind: "typing", ...payload })
    },
    async sendFile(payload) {
      sent.push({ kind: "file", ...payload })
    },
  }
}
