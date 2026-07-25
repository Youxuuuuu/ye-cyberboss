const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

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
      const store = new RuntimeContextStore({
        filePath: path.join(stateDir, "runtime-context.json"),
      })
      store.setActiveContext({
        workspaceRoot: WORKSPACE_ROOT,
        runtimeId,
        threadId: `thread-${runtimeId}-${provider}`,
        senderId: `user-${provider}`,
        provider,
      })
      const observed = []
      const host = new ProjectToolHost({
        runtimeContextStore: store,
        services: {
          channelFile: {
            async sendToCurrentChat(args, context) {
              observed.push({ tool: "file", args, context })
              return { userId: context.senderId, filePath: args.filePath }
            },
          },
          sticker: {
            async sendToCurrentChat(args, context) {
              observed.push({ tool: "sticker", args, context })
              return {
                stickerId: args.stickerId,
                filePath: "D:/study/.cyberboss/stickers/assets/stk_001.gif",
                delivery: { userId: context.senderId },
              }
            },
          },
        },
      })

      await host.invokeTool("cyberboss_channel_send_file", {
        filePath: "D:/study/.cyberboss/inbox/fixture.txt",
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
        observed.map((entry) => ({
          tool: entry.tool,
          provider: entry.context.provider,
          threadId: entry.context.threadId,
          senderId: entry.context.senderId,
        })),
        [
          {
            tool: "file",
            provider,
            threadId: `thread-${runtimeId}-${provider}`,
            senderId: `user-${provider}`,
          },
          {
            tool: "sticker",
            provider,
            threadId: `thread-${runtimeId}-${provider}`,
            senderId: `user-${provider}`,
          },
        ],
      )
    })
  }
}
