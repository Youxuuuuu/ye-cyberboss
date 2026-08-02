const fs = require("fs");
const path = require("path");

const LEDGER_VERSION = 1;

class ThreadUsageLedger {
  constructor({ filePath } = {}) {
    this.filePath = normalizeText(filePath);
    if (!this.filePath) {
      throw new Error("ThreadUsageLedger requires filePath");
    }
    this.state = createEmptyState();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.load();
  }

  applyObservation(observation = {}) {
    const threadId = normalizeText(observation.threadId);
    const runtimeId = normalizeText(observation.runtimeId).toLowerCase();
    if (!threadId || !runtimeId) {
      return null;
    }

    let changed = false;
    if (observation.kind === "message") {
      changed = this.applyMessageObservation(threadId, runtimeId, observation);
    } else if (observation.kind === "cumulative") {
      changed = this.applyCumulativeObservation(threadId, runtimeId, observation);
    } else {
      return null;
    }

    if (!changed) {
      return this.getThreadUsageTotals(threadId);
    }
    this.save();
    return this.getThreadUsageTotals(threadId);
  }

  getThreadUsageTotals(threadId) {
    const entry = this.state.threads[normalizeText(threadId)];
    if (!entry) {
      return null;
    }
    return buildPublicTotals(entry.totals);
  }

  deleteThreadUsage(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId || !this.state.threads[normalizedThreadId]) {
      return false;
    }
    delete this.state.threads[normalizedThreadId];
    this.save();
    return true;
  }

  applyMessageObservation(threadId, runtimeId, observation) {
    const observationId = normalizeText(observation.observationId);
    if (!observationId) {
      return false;
    }
    const contribution = {
      inputTokens: tokenCount(observation.inputTokens)
        + tokenCount(observation.cacheCreationInputTokens)
        + tokenCount(observation.cacheReadInputTokens),
      outputTokens: tokenCount(observation.outputTokens),
      cacheReadInputTokens: tokenCount(observation.cacheReadInputTokens),
    };
    const entry = this.ensureThreadEntry(threadId);
    const key = `${runtimeId}:${observationId}`;
    const previous = entry.messageContributions[key] || emptyTokenCounts();
    if (sameTokenCounts(previous, contribution)) {
      return false;
    }
    entry.messageContributions[key] = contribution;
    entry.totals = addTokenCounts(entry.totals, subtractTokenCounts(contribution, previous));
    entry.updatedAt = new Date().toISOString();
    return true;
  }

  applyCumulativeObservation(threadId, runtimeId, observation) {
    if (!observation.total || typeof observation.total !== "object") {
      return false;
    }
    const total = normalizeTokenCounts(observation.total);
    const last = normalizeTokenCounts(observation.last);
    const signature = tokenCountsSignature(total);
    const entry = this.ensureThreadEntry(threadId);
    const previousState = entry.cumulativeStates[runtimeId];
    if (previousState?.signature === signature) {
      return false;
    }

    let contribution;
    if (!previousState) {
      contribution = last;
    } else if (isAtOrAbove(total, previousState.highWater)) {
      contribution = subtractTokenCounts(total, previousState.highWater);
    } else {
      contribution = last;
    }

    entry.cumulativeStates[runtimeId] = {
      highWater: total,
      signature,
    };
    entry.totals = addTokenCounts(entry.totals, contribution);
    entry.updatedAt = new Date().toISOString();
    return true;
  }

  ensureThreadEntry(threadId) {
    if (!this.state.threads[threadId]) {
      this.state.threads[threadId] = createThreadEntry();
    }
    return this.state.threads[threadId];
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.state = normalizeState(parsed);
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    this.state = normalizeState(this.state);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporaryPath, this.filePath);
  }
}

function createEmptyState() {
  return {
    version: LEDGER_VERSION,
    threads: {},
  };
}

function createThreadEntry() {
  return {
    totals: emptyTokenCounts(),
    messageContributions: {},
    cumulativeStates: {},
    updatedAt: new Date().toISOString(),
  };
}

function normalizeState(value) {
  const state = createEmptyState();
  if (!value || typeof value !== "object" || !value.threads || typeof value.threads !== "object") {
    return state;
  }
  for (const [rawThreadId, rawEntry] of Object.entries(value.threads)) {
    const threadId = normalizeText(rawThreadId);
    if (!threadId || !rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const entry = createThreadEntry();
    entry.totals = normalizeTokenCounts(rawEntry.totals);
    entry.messageContributions = normalizeContributionMap(rawEntry.messageContributions);
    entry.cumulativeStates = normalizeCumulativeStateMap(rawEntry.cumulativeStates);
    entry.updatedAt = normalizeText(rawEntry.updatedAt) || entry.updatedAt;
    state.threads[threadId] = entry;
  }
  return state;
}

function normalizeContributionMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => normalizeText(key))
      .map(([key, contribution]) => [key, normalizeTokenCounts(contribution)]),
  );
}

function normalizeCumulativeStateMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result = {};
  for (const [rawRuntimeId, rawState] of Object.entries(value)) {
    const runtimeId = normalizeText(rawRuntimeId).toLowerCase();
    if (!runtimeId || !rawState || typeof rawState !== "object") {
      continue;
    }
    const highWater = normalizeTokenCounts(rawState.highWater);
    result[runtimeId] = {
      highWater,
      signature: normalizeText(rawState.signature) || tokenCountsSignature(highWater),
    };
  }
  return result;
}

function buildPublicTotals(value) {
  const totals = normalizeTokenCounts(value);
  const totalTokens = totals.inputTokens + totals.outputTokens;
  return {
    ...totals,
    totalTokens,
    cacheHitRate: totals.inputTokens > 0
      ? Math.min(1, totals.cacheReadInputTokens / totals.inputTokens)
      : 0,
  };
}

function emptyTokenCounts() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function normalizeTokenCounts(value) {
  return {
    inputTokens: tokenCount(value?.inputTokens),
    outputTokens: tokenCount(value?.outputTokens),
    cacheReadInputTokens: tokenCount(value?.cacheReadInputTokens),
  };
}

function addTokenCounts(left, right) {
  return {
    inputTokens: Math.max(0, tokenCount(left?.inputTokens) + numberOrZero(right?.inputTokens)),
    outputTokens: Math.max(0, tokenCount(left?.outputTokens) + numberOrZero(right?.outputTokens)),
    cacheReadInputTokens: Math.max(
      0,
      tokenCount(left?.cacheReadInputTokens) + numberOrZero(right?.cacheReadInputTokens),
    ),
  };
}

function subtractTokenCounts(left, right) {
  return {
    inputTokens: tokenCount(left?.inputTokens) - tokenCount(right?.inputTokens),
    outputTokens: tokenCount(left?.outputTokens) - tokenCount(right?.outputTokens),
    cacheReadInputTokens: tokenCount(left?.cacheReadInputTokens) - tokenCount(right?.cacheReadInputTokens),
  };
}

function sameTokenCounts(left, right) {
  return (
    tokenCount(left?.inputTokens) === tokenCount(right?.inputTokens)
    && tokenCount(left?.outputTokens) === tokenCount(right?.outputTokens)
    && tokenCount(left?.cacheReadInputTokens) === tokenCount(right?.cacheReadInputTokens)
  );
}

function isAtOrAbove(value, baseline) {
  return (
    tokenCount(value?.inputTokens) >= tokenCount(baseline?.inputTokens)
    && tokenCount(value?.outputTokens) >= tokenCount(baseline?.outputTokens)
    && tokenCount(value?.cacheReadInputTokens) >= tokenCount(baseline?.cacheReadInputTokens)
  );
}

function tokenCountsSignature(value) {
  const normalized = normalizeTokenCounts(value);
  return `${normalized.inputTokens}:${normalized.outputTokens}:${normalized.cacheReadInputTokens}`;
}

function tokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ThreadUsageLedger };
