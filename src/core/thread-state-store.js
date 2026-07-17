class ThreadStateStore {
  constructor() {
    this.stateByThreadId = new Map();
    this.latestContextByRuntime = new Map();
  }

  applyRuntimeEvent(event) {
    if (event?.type === "runtime.turn.correlated") {
      return;
    }
    if (event?.type === "runtime.context.updated") {
      const updatedAt = new Date().toISOString();
      const runtimeId = normalizeRuntimeId(event?.payload?.runtimeId);
      const snapshot = {
        ...event.payload,
        updatedAt,
      };
      if (runtimeId) {
        this.latestContextByRuntime.set(runtimeId, snapshot);
      }
      const threadId = normalizeThreadId(event?.payload?.threadId);
      if (threadId) {
        const current = this.stateByThreadId.get(threadId) || createEmptyThreadState(threadId);
        this.stateByThreadId.set(threadId, {
          ...current,
          context: snapshot,
          updatedAt,
        });
      }
      return;
    }
    if (!event || !event.payload || !event.payload.threadId) {
      return;
    }

    const threadId = event.payload.threadId;
    const current = this.stateByThreadId.get(threadId) || createEmptyThreadState(threadId);
    const next = {
      ...current,
      updatedAt: new Date().toISOString(),
    };

    switch (event.type) {
      case "runtime.turn.started":
        next.status = "running";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastError = "";
        break;
      case "runtime.reply.delta":
        next.status = "running";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastReplyText = event.payload.text || next.lastReplyText;
        break;
      case "runtime.reply.completed":
        next.status = "running";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastReplyText = event.payload.text || next.lastReplyText;
        break;
      case "runtime.approval.requested":
        next.status = "waiting_approval";
        next.pendingApprovals = upsertPendingApprovalQueue(
          next.pendingApprovals,
          buildPendingApproval(event.payload),
        );
        next.pendingApproval = next.pendingApprovals[0] || null;
        break;
      case "runtime.turn.completed":
        next.status = "idle";
        next.turnId = event.payload.turnId || next.turnId;
        next.pendingApproval = null;
        next.pendingApprovals = [];
        break;
      case "runtime.turn.failed":
        next.status = "failed";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastError = event.payload.text || "❌ Execution failed";
        next.pendingApproval = null;
        next.pendingApprovals = [];
        break;
      default:
        break;
    }

    this.stateByThreadId.set(threadId, next);
  }

  getThreadState(threadId) {
    return this.stateByThreadId.get(threadId) || null;
  }

  resolveApproval(threadId, status = "running", requestId = null) {
    const current = this.stateByThreadId.get(threadId);
    if (!current) {
      return null;
    }
    const nextPendingApprovals = shiftPendingApprovalQueue(current.pendingApprovals, requestId);
    const next = {
      ...current,
      status: nextPendingApprovals.length ? "waiting_approval" : status,
      pendingApproval: nextPendingApprovals[0] || null,
      pendingApprovals: nextPendingApprovals,
      updatedAt: new Date().toISOString(),
    };
    this.stateByThreadId.set(threadId, next);
    return next;
  }

  snapshot() {
    return Array.from(this.stateByThreadId.values()).map((entry) => ({ ...entry }));
  }

  getLatestContext(runtimeId) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) {
      return null;
    }
    const snapshot = this.latestContextByRuntime.get(normalizedRuntimeId);
    return snapshot ? { ...snapshot } : null;
  }
}

function createEmptyThreadState(threadId) {
  return {
    threadId,
    turnId: "",
    status: "idle",
    lastReplyText: "",
    lastError: "",
    context: null,
    pendingApproval: null,
    pendingApprovals: [],
    updatedAt: new Date().toISOString(),
  };
}

function buildPendingApproval(payload) {
  return {
    kind: payload?.kind || "command",
    requestId: payload?.requestId ?? null,
    reason: payload?.reason || "",
    command: payload?.command || "",
    commandTokens: Array.isArray(payload?.commandTokens) ? payload.commandTokens : [],
    filePath: payload?.filePath || "",
    filePaths: Array.isArray(payload?.filePaths) ? payload.filePaths.slice() : [],
    elicitation: payload?.elicitation || null,
    responseTemplate: payload?.responseTemplate || null,
  };
}

function upsertPendingApprovalQueue(queue, approval) {
  if (!approval || approval.requestId == null) {
    return Array.isArray(queue) ? queue.slice() : [];
  }
  const requestId = String(approval.requestId).trim();
  if (!requestId) {
    return Array.isArray(queue) ? queue.slice() : [];
  }
  const current = Array.isArray(queue) ? queue.slice() : [];
  const index = current.findIndex((entry) => String(entry?.requestId ?? "").trim() === requestId);
  if (index >= 0) {
    current[index] = approval;
    return current;
  }
  current.push(approval);
  return current;
}

function shiftPendingApprovalQueue(queue, requestId = null) {
  const current = Array.isArray(queue) ? queue.slice() : [];
  if (!current.length) {
    return [];
  }
  const normalizedRequestId = requestId == null ? "" : String(requestId).trim();
  if (!normalizedRequestId) {
    current.shift();
    return current;
  }
  return current.filter((entry) => String(entry?.requestId ?? "").trim() !== normalizedRequestId);
}

function normalizeRuntimeId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeThreadId(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ThreadStateStore };
