const {
  extractApprovalCommandTokens,
  extractApprovalFilePath,
  extractApprovalFilePaths,
  buildApprovalMatchTokens,
} = require("../shared/approval-command");

const RUNTIME_PROCESS_EXIT_NOISE = "❌ Runtime process exited unexpectedly";

function mapClaudeCodeMessageToRuntimeEvent(message, raw, { model = "" } = {}) {
  const type = message?.type;
  switch (type) {
    case "context.updated":
      return {
        type: "runtime.context.updated",
        payload: normalizeClaudeContextPayload(message, raw, { model }),
      };
    case "usage.updated":
      return {
        type: "runtime.context.updated",
        payload: normalizeClaudeContextPayload(message, raw, { model }),
      };
    case "turn.started":
      return {
        type: "runtime.turn.started",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          requestId: message.requestId,
          messageId: message.messageId,
          logicalTurnId: message.logicalTurnId,
          displayTurnId: message.displayTurnId,
          transportTurnId: message.transportTurnId || message.turnId,
        },
      };
    case "turn.correlated":
      return {
        type: "runtime.turn.correlated",
        payload: {
          threadId: message.sessionId,
          requestId: message.requestId,
          messageId: message.messageId,
          logicalTurnId: message.logicalTurnId,
          displayTurnId: message.displayTurnId || message.logicalTurnId,
          transportTurnId: message.transportTurnId || message.turnId,
          canonicalTurnId: message.canonicalTurnId,
        },
      };
    case "reply.completed":
      return {
        type: "runtime.reply.completed",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          itemId: normalizeString(message.itemId),
          text: message.text,
        },
      };
    case "turn.completed":
      return {
        type: "runtime.turn.completed",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          requestId: message.requestId,
          messageId: message.messageId,
          logicalTurnId: message.logicalTurnId,
          displayTurnId: message.displayTurnId || message.logicalTurnId,
          transportTurnId: message.transportTurnId || message.turnId,
          canonicalTurnId: message.canonicalTurnId,
          itemId: normalizeString(message.itemId),
          text: typeof message.text === "string" ? message.text : "",
        },
      };
    case "approval.requested":
      const readableToolName = formatReadableToolName(message.toolName);
      return {
        type: "runtime.approval.requested",
        payload: {
          threadId: message.sessionId,
          requestId: message.requestId,
          reason: `Tool: ${readableToolName || ""}`,
          command: formatToolCommand(message.toolName, message.input),
          filePath: extractApprovalFilePath(message.input, { preferredKeys: ["file_path", "filePath", "path"] }),
          filePaths: extractApprovalFilePaths(message.input, { preferredKeys: ["file_path", "filePath", "path"] }),
          commandTokens: buildApprovalMatchTokens({
            toolName: message.toolName,
            commandTokens: extractApprovalCommandTokens(message.input, { preferredKeys: ["prefix_rule"] }),
            input: message.input,
            options: { preferredKeys: ["prefix_rule"] },
          }),
        },
      };
    case "process.error":
    case "process.close": {
      const runtimeErrorText = normalizeString(message.error);
      const silent = !runtimeErrorText || runtimeErrorText === RUNTIME_PROCESS_EXIT_NOISE;
      return {
        type: "runtime.turn.failed",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          text: runtimeErrorText || RUNTIME_PROCESS_EXIT_NOISE,
          silent,
        },
      };
    }
    case "session.id":
      return null;
    default:
      return null;
  }
}

function formatToolCommand(toolName, input) {
  const name = formatReadableToolName(toolName);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return name;
  }
  const keys = Object.keys(input);
  if (keys.length === 0) {
    return name;
  }
  const formatted = keys
    .map((key) => `${key}: ${JSON.stringify(input[key])}`)
    .join("\n");
  const full = `${name}\n${formatted}`;
  return truncateCommand(full);
}

function formatReadableToolName(toolName) {
  const normalized = typeof toolName === "string" ? toolName.trim() : "";
  if (!normalized.startsWith("mcp__")) {
    return normalized;
  }
  const parts = normalized.split("__").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "mcp") {
    return normalized;
  }
  return parts.slice(2).join("__") || normalized;
}

function truncateCommand(text, maxLines = 6, maxLineLength = 100) {
  const lines = String(text || "").split("\n");
  const truncated = lines.slice(0, maxLines).map((line) => {
    if (line.length <= maxLineLength) return line;
    return line.slice(0, maxLineLength) + " …";
  });
  const result = truncated.join("\n");
  if (lines.length > maxLines) {
    return result + "\n…";
  }
  return result;
}

function normalizeClaudeContextPayload(message, raw, { model = "" } = {}) {
  const isTurnAggregate = message?.type === "usage.updated";
  const hasReportedContext = message?.contextUsage && typeof message.contextUsage === "object";
  const canUseSingleCallResult = isTurnAggregate
    && !hasReportedContext
    && Number(message?.numTurns) === 1
    && raw?.usage
    && typeof raw.usage === "object";
  const contextUsage = isTurnAggregate
    ? (hasReportedContext ? message.contextUsage : canUseSingleCallResult ? raw.usage : {})
    : raw?.message?.usage && typeof raw.message.usage === "object"
      ? raw.message.usage
      : (message?.usage && typeof message.usage === "object" ? message.usage : {});
  const usage = isTurnAggregate && raw?.usage && typeof raw.usage === "object"
    ? raw.usage
    : contextUsage;
  const runtimeId = "claudecode";
  const threadId = normalizeString(message?.sessionId);
  const observationId = normalizeString(
    message?.turnId
      || raw?.message?.id
      || message?.messageId
      || message?.message_id
  );
  const inputTokens = numberOrZero(contextUsage.input_tokens);
  const cacheCreationInputTokens = numberOrZero(contextUsage.cache_creation_input_tokens);
  const cacheReadInputTokens = numberOrZero(contextUsage.cache_read_input_tokens);
  const outputTokens = numberOrZero(contextUsage.output_tokens);
  const contextSnapshot = {
    runtimeId,
    threadId,
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    currentTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens,
    latestInputTokens: numberOrZero(usage.input_tokens),
    latestCacheCreationInputTokens: numberOrZero(usage.cache_creation_input_tokens),
    latestCacheReadInputTokens: numberOrZero(usage.cache_read_input_tokens),
    latestOutputTokens: numberOrZero(usage.output_tokens),
    contextWindow: resolveClaudeCodeEffectiveContextWindow(model),
  };
  return {
    ...contextSnapshot,
    contextSnapshot,
    usageObservation: {
      kind: "message",
      runtimeId,
      threadId,
      observationId,
      inputTokens: numberOrZero(usage.input_tokens),
      cacheCreationInputTokens: numberOrZero(usage.cache_creation_input_tokens),
      cacheReadInputTokens: numberOrZero(usage.cache_read_input_tokens),
      outputTokens: numberOrZero(usage.output_tokens),
    },
  };
}

function resolveClaudeCodeEffectiveContextWindow(model) {
  const normalizedModel = normalizeString(model);
  if (!normalizedModel) return 0;
  return /\[1m\]$/iu.test(normalizedModel) ? 1_000_000 : 200_000;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

module.exports = { mapClaudeCodeMessageToRuntimeEvent };
