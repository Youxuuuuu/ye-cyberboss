const crypto = require("crypto");
const os = require("os");
const path = require("path");

function resolveClaudeCodeIpcConfig({ stateDir = "" } = {}) {
  const resolvedStateDir = normalizeStateDir(stateDir);
  const tokenFilePath = path.join(resolvedStateDir, "claudecode-runtime.sock.token");

  if (process.platform === "win32") {
    const pipeName = buildWindowsPipeName(resolvedStateDir);
    return {
      endpointPath: `\\\\.\\pipe\\${pipeName}`,
      tokenFilePath,
      displayPath: `${resolvedStateDir}\\claudecode-runtime.sock`,
      usesFilesystemSocket: false,
    };
  }

  const endpointPath = path.join(resolvedStateDir, "claudecode-runtime.sock");
  return {
    endpointPath,
    tokenFilePath,
    displayPath: endpointPath,
    usesFilesystemSocket: true,
  };
}

function normalizeStateDir(stateDir) {
  const normalized = typeof stateDir === "string" ? stateDir.trim() : "";
  return normalized || path.join(os.homedir(), ".cyberboss");
}

function buildWindowsPipeName(stateDir) {
  const digest = crypto.createHash("sha256")
    .update(path.resolve(stateDir))
    .digest("hex")
    .slice(0, 12);
  return `cyberboss-claudecode-${digest}`;
}

module.exports = {
  resolveClaudeCodeIpcConfig,
};
