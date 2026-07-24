const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("./core/config");
const { renderInstructionTemplate } = require("./core/instructions-template");
const { CyberbossApp } = require("./core/app");
const { runSystemCheckinPoller } = require("./app/system-checkin-poller");
const { buildTerminalHelpText } = require("./core/command-registry");
const { ensureStickerCatalogFilesSync } = require("./services/sticker-service");
const { createProjectTooling } = require("./tools/create-project-tooling");
const { runToolMcpServer } = require("./tools/mcp-stdio-server");
const { normalizeWorkspaceRoot } = require("./core/workspace-root");
const { ConversationImporter } = require("./custom/xiaoye/conversation");

function ensureDefaultStateDirectory() {
  fs.mkdirSync(path.join(os.homedir(), ".cyberboss"), { recursive: true });
}

function loadEnv() {
  ensureDefaultStateDirectory();
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".cyberboss", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath });
    return;
  }
  dotenv.config();
}

function ensureRuntimeEnv() {
  if (!process.env.CYBERBOSS_HOME) {
    process.env.CYBERBOSS_HOME = path.resolve(__dirname, "..");
  }
}

function ensureBootstrapFiles(config) {
  ensureInstructionsTemplate(config);
  ensureStickerCatalogFilesSync(config);
}

function ensureInstructionsTemplate(config) {
  const filePath = typeof config?.weixinInstructionsFile === "string"
    ? config.weixinInstructionsFile.trim()
    : "";
  if (!filePath || fs.existsSync(filePath)) {
    return;
  }

  const templatePath = path.resolve(__dirname, "..", "templates", "weixin-instructions.md");
  let template = "";
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    return;
  }

  const userName = String(config?.userName || "").trim() || "User";
  const content = renderInstructionTemplate(template, {
    ...config,
    userName,
  }).trimEnd() + "\n";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function printHelp() {
  console.log(buildTerminalHelpText());
}

let runtimeErrorHooksInstalled = false;

function installRuntimeErrorHooks() {
  if (runtimeErrorHooksInstalled) {
    return;
  }
  runtimeErrorHooksInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[cyberboss] unhandled rejection ${message}`);
  });

  process.on("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[cyberboss] uncaught exception ${message}`);
    process.exitCode = 1;
  });
}

async function main() {
  loadEnv();
  ensureRuntimeEnv();
  installRuntimeErrorHooks();
  const argv = process.argv.slice(2);
  const config = readConfig();
  ensureBootstrapFiles(config);
  const command = config.mode || "help";
  let app = null;
  const getApp = () => {
    if (!app) {
      app = new CyberbossApp(config);
    }
    return app;
  };

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(buildTerminalHelpText());
    return;
  }

  if (command === "doctor") {
    getApp().printDoctor();
    return;
  }

  if (command === "login") {
    await getApp().login();
    return;
  }

  if (command === "accounts") {
    getApp().printAccounts();
    return;
  }

  if (command === "start") {
    await getApp().start();
    return;
  }

  if (command === "tool-mcp-server") {
    const runtimeId = readFlagValue(argv.slice(1), "--runtime-id") || "";
    const workspaceRoot = normalizeWorkspaceRoot(readFlagValue(argv.slice(1), "--workspace-root") || process.cwd());
    const { toolHost } = createProjectTooling(config);
    runToolMcpServer({ toolHost, runtimeId, workspaceRoot });
    return;
  }

  if (command === "conversation:import") {
    await runConversationImportCommand({
      args: argv.slice(1),
      config,
    });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = { main };

async function runConversationImportCommand({ args = [], config = {} } = {}) {
  const runtimeId = normalizeRuntimeId(
    readFlagValue(args, "--runtime")
    || readFlagValue(args, "--runtime-id")
  );
  const sourceFile = readFlagValue(args, "--source-file") || readFlagValue(args, "--source");
  if (!runtimeId) {
    throw new Error("conversation:import requires --runtime <codex|claudecode>");
  }
  if (!sourceFile) {
    throw new Error("conversation:import requires --source-file <path>");
  }

  const conversationDir = readFlagValue(args, "--conversation-dir") || config.conversationDir;
  const stateDir = readFlagValue(args, "--state-dir") || config.stateDir;
  const workspaceRoot = normalizeWorkspaceRoot(
    readFlagValue(args, "--workspace-root")
    || config.workspaceRoot
    || process.cwd()
  );
  if (!conversationDir) {
    throw new Error("conversation:import could not resolve conversationDir");
  }
  if (!stateDir) {
    throw new Error("conversation:import could not resolve stateDir");
  }

  const importer = new ConversationImporter({
    config: {
      conversationDir,
      stateDir,
    },
    logger: console,
  });

  const result = importer.importFile({
    runtimeId,
    sourceFile,
    workspaceRoot,
  });

  console.log(`[cyberboss] conversation import complete`);
  console.log(`runtimeId: ${runtimeId}`);
  console.log(`sourceFile: ${sourceFile}`);
  console.log(`conversationDir: ${conversationDir}`);
  console.log(`stateDir: ${stateDir}`);
  console.log(`workspaceRoot: ${workspaceRoot}`);
  console.log(`importedCount: ${result.importedCount}`);
  console.log(`writtenCount: ${result.writtenCount}`);
  console.log(`warnings: ${result.warnings.length}`);
}

function readFlagValue(args, flag) {
  if (!Array.isArray(args)) {
    return "";
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return String(args[index + 1] || "").trim();
    }
  }
  return "";
}

function normalizeRuntimeId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "codex" || normalized === "claudecode") {
    return normalized;
  }
  return "";
}
