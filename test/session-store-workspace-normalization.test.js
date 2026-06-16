const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SessionStore } = require("../src/adapters/runtime/codex/session-store");

test("SessionStore normalizes a single workspaceRoot variant and writes one backup", () => {
  const { filePath, rootDir } = createTempSessionFile({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "D:\\study\\cyberboss",
        threadIdByWorkspaceRootByRuntime: {
          codex: {
            "D:\\study\\cyberboss": "thread-1",
          },
        },
      },
    },
  });

  const store = new SessionStore({ filePath, runtimeId: "codex" });
  const saved = readJson(filePath);

  assert.equal(store.getActiveWorkspaceRoot("binding-1"), "D:/study/cyberboss");
  assert.equal(
    saved.bindings["binding-1"].threadIdByWorkspaceRootByRuntime.codex["D:/study/cyberboss"],
    "thread-1"
  );
  assert.deepEqual(listBackupFiles(rootDir), ["sessions.json.bak-20000102-030405"]);
});

test("SessionStore merges slash-only duplicate workspaceRoot keys when values are equivalent", () => {
  const { filePath, rootDir } = createTempSessionFile({
    bindings: {
      "binding-1": {
        threadIdByWorkspaceRootByRuntime: {
          codex: {
            "D:\\study\\cyberboss": "thread-1",
            "D:/study/cyberboss": "thread-1",
          },
        },
      },
    },
  });

  new SessionStore({ filePath, runtimeId: "codex" });
  const saved = readJson(filePath);

  assert.deepEqual(
    Object.keys(saved.bindings["binding-1"].threadIdByWorkspaceRootByRuntime.codex),
    ["D:/study/cyberboss"]
  );
  assert.deepEqual(listBackupFiles(rootDir), ["sessions.json.bak-20000102-030405"]);
});

test("SessionStore throws on threadId collision and does not rewrite sessions.json", () => {
  const { filePath, rootDir, rawContent } = createTempSessionFile({
    bindings: {
      "binding-1": {
        threadIdByWorkspaceRootByRuntime: {
          codex: {
            "D:\\study\\cyberboss": "thread-1",
            "D:/study/cyberboss": "thread-2",
          },
        },
      },
    },
  });

  assert.throws(
    () => new SessionStore({ filePath, runtimeId: "codex" }),
    /normalized workspaceRoot: D:\/study\/cyberboss/
  );
  assert.match(
    fs.readFileSync(filePath, "utf8"),
    /thread-2/
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), rawContent);
  assert.deepEqual(listBackupFiles(rootDir), []);
});

test("SessionStore throws on runtime params collision and does not rewrite sessions.json", () => {
  const { filePath, rootDir, rawContent } = createTempSessionFile({
    bindings: {
      "binding-1": {
        runtimeParamsByWorkspaceRootByRuntime: {
          codex: {
            "D:\\study\\cyberboss": {
              model: "gpt-5",
              modelProvider: "openai",
            },
            "D:/study/cyberboss": {
              model: "gpt-5-mini",
              modelProvider: "openai",
            },
          },
        },
      },
    },
  });

  assert.throws(
    () => new SessionStore({ filePath, runtimeId: "codex" }),
    /runtimeParamsByWorkspaceRootByRuntime/
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), rawContent);
  assert.deepEqual(listBackupFiles(rootDir), []);
});

test("SessionStore throws on allowlist collision and does not rewrite sessions.json", () => {
  const { filePath, rootDir, rawContent } = createTempSessionFile({
    bindings: {
      "binding-1": {},
    },
    approvalCommandAllowlistByWorkspaceRoot: {
      "D:\\study\\cyberboss": [["npm", "run", "dev"]],
      "D:/study/cyberboss": [["npm", "run", "check"]],
    },
  });

  assert.throws(
    () => new SessionStore({ filePath, runtimeId: "codex" }),
    /approvalCommandAllowlistByWorkspaceRoot/
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), rawContent);
  assert.deepEqual(listBackupFiles(rootDir), []);
});

function createTempSessionFile(content) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-session-store-"));
  const filePath = path.join(rootDir, "sessions.json");
  const rawContent = JSON.stringify(content, null, 2);
  fs.writeFileSync(filePath, rawContent, "utf8");
  return { filePath, rootDir, rawContent };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listBackupFiles(rootDir) {
  return fs.readdirSync(rootDir)
    .filter((name) => /^sessions\.json\.bak-\d{8}-\d{6}$/.test(name))
    .sort();
}

const REAL_DATE = Date;

class FixedDate extends Date {
  constructor(...args) {
    if (args.length) {
      super(...args);
      return;
    }
    super("2000-01-02T03:04:05");
  }

  static now() {
    return new REAL_DATE("2000-01-02T03:04:05").getTime();
  }
}

global.Date = FixedDate;
