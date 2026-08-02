const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ThreadUsageLedger } = require("../src/core/thread-usage-ledger");

function createLedger() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-thread-usage-"));
  const filePath = path.join(root, "thread-usage.json");
  return {
    filePath,
    ledger: new ThreadUsageLedger({ filePath }),
  };
}

test("Claude turn usage is token-normalized and final usage replaces the same turn contribution", () => {
  const { ledger } = createLedger();

  ledger.applyObservation({
    kind: "message",
    runtimeId: "claudecode",
    threadId: "thread-1",
    observationId: "turn-1",
    inputTokens: 10,
    cacheCreationInputTokens: 20,
    cacheReadInputTokens: 70,
    outputTokens: 5,
  });
  ledger.applyObservation({
    kind: "message",
    runtimeId: "claudecode",
    threadId: "thread-1",
    observationId: "turn-1",
    inputTokens: 12,
    cacheCreationInputTokens: 18,
    cacheReadInputTokens: 80,
    outputTokens: 7,
  });

  assert.deepEqual(ledger.getThreadUsageTotals("thread-1"), {
    inputTokens: 110,
    outputTokens: 7,
    cacheReadInputTokens: 80,
    totalTokens: 117,
    cacheHitRate: 80 / 110,
  });
});

test("Codex cumulative snapshots start with the current last-token contribution and then add high-water deltas", () => {
  const { ledger } = createLedger();

  ledger.applyObservation({
    kind: "cumulative",
    runtimeId: "codex",
    threadId: "thread-2",
    total: {
      inputTokens: 1_000,
      cacheReadInputTokens: 800,
      outputTokens: 100,
    },
    last: {
      inputTokens: 100,
      cacheReadInputTokens: 80,
      outputTokens: 10,
    },
  });
  ledger.applyObservation({
    kind: "cumulative",
    runtimeId: "codex",
    threadId: "thread-2",
    total: {
      inputTokens: 1_250,
      cacheReadInputTokens: 1_000,
      outputTokens: 130,
    },
    last: {
      inputTokens: 250,
      cacheReadInputTokens: 200,
      outputTokens: 30,
    },
  });

  assert.deepEqual(ledger.getThreadUsageTotals("thread-2"), {
    inputTokens: 350,
    outputTokens: 40,
    cacheReadInputTokens: 280,
    totalTokens: 390,
    cacheHitRate: 0.8,
  });
});

test("usage totals survive restart and permanent deletion removes the ledger entry", () => {
  const { filePath, ledger } = createLedger();
  ledger.applyObservation({
    kind: "message",
    runtimeId: "claudecode",
    threadId: "thread-3",
    observationId: "message-3",
    inputTokens: 6,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 2,
    outputTokens: 4,
  });

  const reloaded = new ThreadUsageLedger({ filePath });
  assert.equal(reloaded.getThreadUsageTotals("thread-3").totalTokens, 14);

  assert.equal(reloaded.deleteThreadUsage("thread-3"), true);
  assert.equal(new ThreadUsageLedger({ filePath }).getThreadUsageTotals("thread-3"), null);
});

test("observations without authoritative identity or usage are ignored", () => {
  const { ledger } = createLedger();

  assert.equal(ledger.applyObservation({
    kind: "message",
    runtimeId: "claudecode",
    threadId: "thread-4",
    inputTokens: 12,
  }), null);
  assert.equal(ledger.applyObservation({
    kind: "cumulative",
    runtimeId: "codex",
    threadId: "thread-4",
  }), null);
  assert.equal(ledger.getThreadUsageTotals("thread-4"), null);
});
