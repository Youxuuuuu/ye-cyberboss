const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { saveWeixinAccount } = require("../src/adapters/channel/weixin/account-store")
const { persistContextToken } = require("../src/adapters/channel/weixin/context-token-store")
const { ChannelFileService } = require("../src/services/channel-file-service")
const { StickerService } = require("../src/services/sticker-service")
const { RuntimeContextStore } = require("../src/tools/runtime-context-store")
const { ProjectToolHost } = require("../src/tools/tool-host")

const WORKSPACE_ROOT = "D:/study/cyberboss"

test("runtime tool context persists the inbound channel provider", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tool-context-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const filePath = path.join(stateDir, "runtime-context.json")
  const store = new RuntimeContextStore({ filePath })

  store.setActiveContext({
    workspaceRoot: WORKSPACE_ROOT,
    runtimeId: "codex",
    threadId: "thread-web",
    senderId: "user-web",
    provider: "web",
  })

  const restored = new RuntimeContextStore({ filePath })
  assert.equal(
    restored.resolveActiveContext({ workspaceRoot: WORKSPACE_ROOT }).provider,
    "web",
  )
})

for (const runtimeId of ["codex", "claudecode"]) {
  for (const provider of ["web", "weixin"]) {
    test(`${runtimeId} tools inherit the ${provider} provider from shared context`, async (t) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tool-provider-"))
      t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
      const config = createDeliveryConfig(stateDir)
      const senderId = `user-${provider}`
      if (provider === "weixin") {
        saveWeixinAccount(config, "wx-account", {
          token: "fixture-account-token",
          baseUrl: config.weixinBaseUrl,
          userId: "fixture-bot",
        })
        persistContextToken(config, "wx-account", senderId, "fixture-context-token")
      }
      const delivered = []
      const channelAdapter = {
        getWebReplyTarget() {
          return null
        },
        async sendTyping() {},
        async sendFile(payload) {
          delivered.push(payload)
        },
      }
      const sessionStore = { state: { bindings: {} } }
      const channelFile = new ChannelFileService({
        config,
        channelAdapter,
        sessionStore,
      })
      const sticker = new StickerService({
        config,
        channelAdapter,
        sessionStore,
        channelFileService: channelFile,
      })
      const store = new RuntimeContextStore({
        filePath: path.join(stateDir, "runtime-context.json"),
      })
      store.setActiveContext({
        workspaceRoot: WORKSPACE_ROOT,
        runtimeId,
        threadId: `thread-${runtimeId}-${provider}`,
        senderId,
        provider,
      })
      const host = new ProjectToolHost({
        runtimeContextStore: store,
        services: {
          channelFile,
          sticker,
        },
      })

      await host.invokeTool("cyberboss_channel_send_file", {
        filePath: config.fixtureFilePath,
      }, {
        workspaceRoot: WORKSPACE_ROOT,
        runtimeId,
      })
      await host.invokeTool("cyberboss_sticker_send", {
        stickerId: "stk_001",
      }, {
        workspaceRoot: WORKSPACE_ROOT,
        runtimeId,
      })

      assert.deepEqual(
        delivered.map((entry) => ({
          provider: entry.provider,
          threadId: entry.threadId,
          userId: entry.userId,
          contextToken: entry.contextToken,
          kind: entry.file?.kind || "file",
        })),
        [
          {
            provider,
            threadId: `thread-${runtimeId}-${provider}`,
            userId: senderId,
            contextToken: provider === "weixin" ? "fixture-context-token" : "",
            kind: "file",
          },
          {
            provider,
            threadId: `thread-${runtimeId}-${provider}`,
            userId: senderId,
            contextToken: provider === "weixin" ? "fixture-context-token" : "",
            kind: "sticker",
          },
        ],
      )
    })
  }
}

function createDeliveryConfig(stateDir) {
  const stickersDir = path.join(stateDir, "stickers")
  const stickerAssetsDir = path.join(stickersDir, "assets")
  const fixtureFilePath = path.join(stateDir, "inbox", "fixture.txt")
  fs.mkdirSync(path.dirname(fixtureFilePath), { recursive: true })
  fs.mkdirSync(stickerAssetsDir, { recursive: true })
  fs.writeFileSync(fixtureFilePath, "fixture", "utf8")
  fs.writeFileSync(path.join(stickerAssetsDir, "stk_001.gif"), "fixture", "utf8")
  fs.writeFileSync(path.join(stickersDir, "index.json"), JSON.stringify({
    stk_001: {
      tags: ["fixture"],
      desc: "fixture sticker description",
    },
  }), "utf8")
  fs.writeFileSync(path.join(stickersDir, "tags.json"), JSON.stringify(["fixture"]), "utf8")
  return {
    stateDir,
    accountsDir: path.join(stateDir, "accounts"),
    accountId: "wx-account",
    weixinBaseUrl: "https://ilinkai.weixin.qq.com",
    workspaceId: "default",
    allowedUserIds: [],
    stickersDir,
    stickerAssetsDir,
    stickersIndexFile: path.join(stickersDir, "index.json"),
    stickerTagsFile: path.join(stickersDir, "tags.json"),
    stickersTemplateDir: path.join(stateDir, "templates", "stickers"),
    stickersTemplateIndexFile: path.join(stateDir, "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.join(stateDir, "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.join(stateDir, "scripts", "normalize-sticker-gif.js"),
    fixtureFilePath,
  }
}
