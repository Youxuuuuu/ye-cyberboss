function createChannelRouter({ weixin, web }) {
  function resolveAdapter(provider = "") {
    return String(provider || "").trim().toLowerCase() === "web" ? web : weixin;
  }

  return {
    describe() {
      return {
        id: "multi",
        kind: "channel",
        providers: {
          weixin: weixin.describe(),
          web: web.describe(),
        },
      };
    },
    login(...args) {
      return weixin.login(...args);
    },
    printAccounts(...args) {
      return weixin.printAccounts(...args);
    },
    resolveAccount(...args) {
      return weixin.resolveAccount(...args);
    },
    getKnownContextTokens(...args) {
      return weixin.getKnownContextTokens(...args);
    },
    loadSyncBuffer(...args) {
      return weixin.loadSyncBuffer(...args);
    },
    saveSyncBuffer(...args) {
      return weixin.saveSyncBuffer(...args);
    },
    rememberContextToken(...args) {
      return weixin.rememberContextToken(...args);
    },
    getUpdates(...args) {
      return weixin.getUpdates(...args);
    },
    normalizeIncomingMessage(...args) {
      return weixin.normalizeIncomingMessage(...args);
    },
    sendText(payload = {}) {
      return resolveAdapter(payload.provider).sendText(payload);
    },
    sendTyping(payload = {}) {
      return resolveAdapter(payload.provider).sendTyping(payload);
    },
    sendFile(payload = {}) {
      return resolveAdapter(payload.provider).sendFile(payload);
    },
    setMinChunkChars(...args) {
      return weixin.setMinChunkChars(...args);
    },
    getMinChunkChars(...args) {
      return weixin.getMinChunkChars(...args);
    },
    getWebReplyTarget(userId) {
      return web.getReplyTarget(userId);
    },
    getWebAdapter() {
      return web;
    },
  };
}

module.exports = { createChannelRouter };
