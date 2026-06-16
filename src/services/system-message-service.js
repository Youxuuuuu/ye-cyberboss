const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
const { normalizeWorkspaceRoot } = require("../core/workspace-root");

class SystemMessageService {
  constructor({ config, sessionStore }) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  }

  queueMessage({ text = "", userId = "", workspaceRoot = "" } = {}, context = {}) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      throw new Error("system send requires text");
    }
    if (isFinalActionJson(normalizedText)) {
      throw new Error("action JSON cannot be enqueued as a system trigger");
    }

    const account = resolveSelectedAccount(this.config);
    const senderId = normalizeText(userId)
      || normalizeText(context?.senderId)
      || resolvePreferredSenderId({
        config: this.config,
        accountId: account.accountId,
        sessionStore: this.sessionStore,
      });
    const resolvedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot)
      || normalizeWorkspaceRoot(context?.workspaceRoot)
      || resolvePreferredWorkspaceRoot({
        config: this.config,
        accountId: account.accountId,
        senderId,
        sessionStore: this.sessionStore,
      });

    if (!senderId || !resolvedWorkspaceRoot) {
      throw new Error("system send requires a sender and workspace");
    }
    if (!path.isAbsolute(resolvedWorkspaceRoot)) {
      throw new Error(`workspace must be an absolute path: ${resolvedWorkspaceRoot}`);
    }

    let workspaceStats = null;
    try {
      workspaceStats = fs.statSync(resolvedWorkspaceRoot);
    } catch {
      throw new Error(`workspace does not exist: ${resolvedWorkspaceRoot}`);
    }
    if (!workspaceStats.isDirectory()) {
      throw new Error(`workspace is not a directory: ${resolvedWorkspaceRoot}`);
    }

    const contextTokens = loadPersistedContextTokens(this.config, account.accountId);
    if (!contextTokens[senderId]) {
      throw new Error(`Cannot find a context token for user ${senderId}. Let this user talk to the bot once first.`);
    }

    return this.queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId,
      workspaceRoot: resolvedWorkspaceRoot,
      text: normalizedText,
      createdAt: new Date().toISOString(),
    });
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isFinalActionJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const action = normalizeText(parsed.action);
    return action === "silent" || action === "send_message";
  } catch {
    return false;
  }
}

module.exports = { SystemMessageService };
