const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createClaudeEffortCapabilitiesProbe,
  parseClaudeEffortCapabilities,
} = require("../src/adapters/runtime/claudecode/effort-capabilities");

test("Claude effort capabilities are exposed only when --effort appears in CLI help", () => {
  assert.deepEqual(parseClaudeEffortCapabilities("Usage: claude [--effort <level>]"), {
    supported: true,
    options: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "",
  });
  assert.deepEqual(parseClaudeEffortCapabilities("Usage: claude [--model <model>]"), {
    supported: false,
    options: [],
    defaultEffort: "",
  });
});

test("the Claude CLI effort probe runs at most once", async () => {
  let calls = 0;
  const probe = createClaudeEffortCapabilitiesProbe({
    command: "claude",
    platform: "linux",
    spawnSyncImpl() {
      calls += 1;
      return { status: 0, stdout: "--effort <level>", stderr: "" };
    },
  });

  assert.equal((await probe()).supported, true);
  assert.equal((await probe()).supported, true);
  assert.equal(calls, 1);
});
