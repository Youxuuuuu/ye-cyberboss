const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

const { ConversationWriter } = require("../src/custom/xiaoye/conversation")

const REPO_ROOT = path.resolve(__dirname, "..")

test("conversation:delete removes one thread through the offline CLI and returns JSON", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-delete-cli-"))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const conversationDir = path.join(stateDir, "conversations")
  const writer = new ConversationWriter({ conversationDir })
  writer.writeRecords([
    record({
      threadId: "thread-cli-delete",
      sourceKey: "cli|delete",
      text: "delete",
      timestamp: "2026-07-31T01:00:00.000Z",
    }),
    record({
      threadId: "thread-cli-keep",
      sourceKey: "cli|keep",
      text: "keep",
      timestamp: "2026-07-31T01:01:00.000Z",
    }),
  ])

  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "bin", "cyberboss.js"),
      "conversation:delete",
      "--thread-id",
      "thread-cli-delete",
      "--conversation-dir",
      conversationDir,
      "--state-dir",
      stateDir,
      "--json",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CYBERBOSS_STATE_DIR: stateDir,
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    threadId: "thread-cli-delete",
    deletedRecordCount: 1,
    touchedDates: ["2026-07-31"],
    deletedSourceKeys: ["cli|delete"],
  })
  assert.deepEqual(
    readDay(conversationDir, "2026-07-31").map((entry) => entry.threadId),
    ["thread-cli-keep"],
  )
})

test("terminal help documents the offline conversation delete command", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "bin", "cyberboss.js"), "help"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /cyberboss conversation:delete --thread-id <id>/,
  )
})

function record({ threadId, sourceKey, text, timestamp }) {
  return {
    type: "user",
    timestamp,
    runtimeId: "codex",
    threadId,
    turnId: `turn-${threadId}`,
    workspaceRoot: REPO_ROOT,
    text,
    source: {
      provider: "codex",
      sourceKey,
      sourceFile: path.join(REPO_ROOT, "fixture.jsonl"),
      sourceLine: 1,
    },
  }
}

function readDay(conversationDir, date) {
  return fs.readFileSync(path.join(conversationDir, `${date}.jsonl`), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
