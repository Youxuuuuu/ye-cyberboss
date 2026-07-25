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

  async sendToCurrentChat({ filePath = "", userId = "", file = null } = {}, context = {}) {
    const explicitProvider = normalizeChannelProvider(context?.provider);
    const explicitUserId = normalizeText(userId) || normalizeText(context?.senderId);
    const webTarget = explicitProvider === "weixin"
      ? null
      : this.channelAdapter.getWebReplyTarget?.(explicitUserId) || null;
    const deliveryProvider = explicitProvider || normalizeChannelProvider(webTarget?.provider);
    const isWebDelivery = deliveryProvider === "web";
    const account = isWebDelivery ? null : resolveSelectedAccount(this.config);
    const targetUserId = explicitUserId || (isWebDelivery ? "" : resolvePreferredSenderId({
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
    if (!contextToken && !isWebDelivery) {
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
      provider: deliveryProvider,
      threadId: context?.threadId,
    }).catch(() => {});
    const deliveryFile = normalizeDeliveryFile(file, resolvedPath);
    await this.channelAdapter.sendFile({
      userId: targetUserId,
      filePath: resolvedPath,
      ...(deliveryFile ? { file: deliveryFile } : {}),
      contextToken,
      provider: deliveryProvider,
      threadId: context?.threadId,
    });
    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 0,
      contextToken,
      provider: deliveryProvider,
      threadId: context?.threadId,
    }).catch(() => {});
    return { userId: targetUserId, filePath: resolvedPath };
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeChannelProvider(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "web" || normalized === "weixin" ? normalized : "";
}

function normalizeDeliveryFile(file, resolvedPath) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    return null;
  }
  return {
    ...file,
    path: normalizeText(file.path) || resolvedPath,
    fileName: normalizeText(file.fileName) || path.basename(resolvedPath),
  };
}

module.exports = { ChannelFileService };
