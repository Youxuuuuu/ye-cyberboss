const fs = require("fs");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { resolvePreferredSenderId } = require("../core/default-targets");

class ChannelFileService {
  constructor({ config, channelAdapter, sessionStore }) {
    this.config = config;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
  }

  async sendToCurrentChat({ filePath = "", userId = "" } = {}, context = {}) {
    const explicitUserId = normalizeText(userId) || normalizeText(context?.senderId);
    const webTarget = this.channelAdapter.getWebReplyTarget?.(explicitUserId) || null;
    const account = webTarget ? null : resolveSelectedAccount(this.config);
    const targetUserId = explicitUserId || (webTarget ? "" : resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore: this.sessionStore,
    }));
    if (!targetUserId) {
      throw new Error("Cannot determine which WeChat user should receive the file.");
    }

    const contextTokens = account
      ? loadPersistedContextTokens(this.config, account.accountId)
      : {};
    const contextToken = String(webTarget?.contextToken || contextTokens[targetUserId] || "").trim();
    if (!contextToken) {
      throw new Error(`Cannot find a context token for user ${targetUserId}. Let this user talk to the bot once first.`);
    }

    const requestedPath = normalizeText(filePath);
    if (!requestedPath) {
      throw new Error("Missing file path to send.");
    }
    const resolvedPath = path.resolve(requestedPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Only files can be sent, not directories: ${resolvedPath}`);
    }

    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 1,
      contextToken,
      provider: webTarget?.provider,
      threadId: context?.threadId,
    }).catch(() => {});
    await this.channelAdapter.sendFile({
      userId: targetUserId,
      filePath: resolvedPath,
      contextToken,
      provider: webTarget?.provider,
      threadId: context?.threadId,
    });
    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 0,
      contextToken,
      provider: webTarget?.provider,
      threadId: context?.threadId,
    }).catch(() => {});
    return { userId: targetUserId, filePath: resolvedPath };
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ChannelFileService };
