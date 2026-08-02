const { spawnSync } = require("child_process");
const os = require("os");

const CLAUDE_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

function createClaudeEffortCapabilitiesProbe({
  command = "claude",
  platform = os.platform(),
  spawnSyncImpl = spawnSync,
} = {}) {
  let cached = null;
  return async function getClaudeEffortCapabilities() {
    if (cached) {
      return cached;
    }
    let result;
    try {
      const spawnSpec = buildHelpSpawnSpec(command, platform);
      result = spawnSyncImpl(spawnSpec.command, spawnSpec.args, {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        shell: false,
      });
    } catch {
      result = null;
    }
    cached = parseClaudeEffortCapabilities(
      `${normalizeText(result?.stdout)}\n${normalizeText(result?.stderr)}`,
    );
    return cached;
  };
}

function parseClaudeEffortCapabilities(helpText) {
  const supported = /(?:^|[\s[])--effort(?:\s|=|<|\[|$)/iu.test(normalizeText(helpText));
  return {
    supported,
    options: supported ? CLAUDE_EFFORT_OPTIONS.slice() : [],
    defaultEffort: "",
  };
}

function buildHelpSpawnSpec(command, platform) {
  const normalizedCommand = normalizeText(command) || "claude";
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", normalizedCommand, "--help"],
    };
  }
  return {
    command: normalizedCommand,
    args: ["--help"],
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  CLAUDE_EFFORT_OPTIONS,
  createClaudeEffortCapabilitiesProbe,
  parseClaudeEffortCapabilities,
};
