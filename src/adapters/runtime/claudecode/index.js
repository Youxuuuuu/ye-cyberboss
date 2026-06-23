const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { ClaudeCodeProcessClient } = require("./process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("./events");
const { ensureClaudeProjectMcpConfig } = require("./project-settings");
const { SessionStore } = require("../codex/session-store");
const { normalizeModelCatalog } = require("../codex/model-catalog");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { ClaudeCodeIpcServer } = require("./ipc-server");
const { resolveClaudeCodeIpcConfig } = require("./ipc-paths");
const { normalizeWorkspaceRoot } = require("../../../core/workspace-root");
const CLAUDE_RESUME_SESSION_TIMEOUT_MS = 8000;
const CLAUDE_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

function createClaudeCodeRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "claudecode" });
  const clientsByWorkspace = new Map();
  const pendingApprovals = new Map();
  const pendingModelByWorkspaceRoot = new Map();
  const configuredModel = normalizeText(config.claudeModel);
  let availableModelCatalogCache = null;
  let globalListener = null;
  const ipcConfig = resolveClaudeCodeIpcConfig({ stateDir: config.stateDir });
  const ipcServer = new ClaudeCodeIpcServer(ipcConfig);

  hydrateRuntimeModelsFromClaudeProjects();

  ipcServer.on("clientMessage", (msg) => {
    if (msg?.type === "sendUserMessage" && msg?.workspaceRoot) {
      const client = clientsByWorkspace.get(normalizeWorkspaceRoot(msg.workspaceRoot));
      if (client?.alive) {
        client.sendUserMessage({ text: msg.text || "" }).catch(() => {});
      }
    }
    if (msg?.type === "respondApproval" && msg?.workspaceRoot) {
      const client = clientsByWorkspace.get(normalizeWorkspaceRoot(msg.workspaceRoot));
      if (client?.alive) {
        client.sendResponse(msg.requestId, { decision: msg.decision }).catch(() => {});
      }
    }
  });

  function resolveModel(model = "") {
    return configuredModel || normalizeText(model);
  }

  async function ensureClient(workspaceRoot, model = "") {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      throw new Error("workspaceRoot is required");
    }
    const desiredModel = resolveModel(model);
    const existing = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (existing) {
      if (normalizeText(existing.model) === desiredModel) {
        return existing;
      }
      await closeWorkspaceClient(normalizedWorkspaceRoot);
    }
    const projectSettings = ensureClaudeProjectMcpConfig({
      workspaceRoot: normalizedWorkspaceRoot,
      cyberbossHome: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
    });
    console.log(
      `[claudecode-runtime] workspace=${normalizedWorkspaceRoot} mcp_config=${projectSettings.configPath} server=${projectSettings.serverName}`
    );
    const client = new ClaudeCodeProcessClient({
      command: config.claudeCommand || "claude",
      cwd: normalizedWorkspaceRoot,
      env: filterClaudeCodeEnv(process.env),
      model: desiredModel,
      permissionMode: config.claudePermissionMode || "default",
      disableVerbose: Boolean(config.claudeDisableVerbose),
      extraArgs: config.claudeExtraArgs || [],
      mcpConfigPaths: [projectSettings.configPath],
      ipcServer,
      workspaceRoot: normalizedWorkspaceRoot,
    });
    client.onMessage((event, raw) => {
      rememberObservedModelForWorkspace(normalizedWorkspaceRoot, extractClaudeMessageModel(raw));
      if (event.type === "session.id") {
        for (const binding of sessionStore.listBindings()) {
          if (normalizeWorkspaceRoot(binding.activeWorkspaceRoot) === normalizedWorkspaceRoot) {
            sessionStore.setThreadIdForWorkspace(binding.bindingKey, normalizedWorkspaceRoot, event.sessionId);
          }
        }
        return;
      }
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped?.payload && !mapped.payload.workspaceRoot) {
        mapped.payload.workspaceRoot = normalizedWorkspaceRoot;
      }
      if (mapped?.type === "runtime.approval.requested") {
        if (pendingApprovals.size >= 100) {
          const firstKey = pendingApprovals.keys().next().value;
          pendingApprovals.delete(firstKey);
        }
        pendingApprovals.set(mapped.payload.requestId, normalizedWorkspaceRoot);
      }
      if (mapped?.type === "runtime.turn.failed") {
        clientsByWorkspace.delete(normalizedWorkspaceRoot);
      }
      if (globalListener && (mapped || raw)) {
        globalListener(mapped, raw);
      }
    });
    clientsByWorkspace.set(normalizedWorkspaceRoot, client);
    return client;
  }

  async function attachClientToThread(workspaceRoot, threadId = "", model = "") {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    const normalizedThreadId = normalizeThreadId(threadId);
    const desiredModel = resolveModel(model);
    if (!normalizedWorkspaceRoot) {
      throw new Error("workspaceRoot is required");
    }

    const existingClient = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (existingClient?.alive && normalizeText(existingClient.model) !== desiredModel) {
      await closeWorkspaceClient(normalizedWorkspaceRoot);
    }

    if (normalizedThreadId && clientMatchesThread(existingClient, normalizedThreadId)) {
      return { client: existingClient, threadId: normalizedThreadId };
    }

    if (!normalizedThreadId && existingClient?.alive) {
      await closeWorkspaceClient(normalizedWorkspaceRoot);
    }

    let client = await ensureClient(normalizedWorkspaceRoot, desiredModel);
    if (!client.alive || (normalizedThreadId && !clientMatchesThread(client, normalizedThreadId))) {
      if (client.alive && normalizedThreadId && !clientMatchesThread(client, normalizedThreadId)) {
        await closeWorkspaceClient(normalizedWorkspaceRoot);
        client = await ensureClient(normalizedWorkspaceRoot, desiredModel);
      }
      await client.connect(normalizedThreadId);
    }

    return { client, threadId: normalizedThreadId || normalizeThreadId(client.sessionId) };
  }
  async function closeWorkspaceClient(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return;
    }
    const client = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (!client) {
      return;
    }
    await client.close();
    clientsByWorkspace.delete(normalizedWorkspaceRoot);
    for (const [requestId, candidateWorkspaceRoot] of pendingApprovals.entries()) {
      if (candidateWorkspaceRoot === normalizedWorkspaceRoot) {
        pendingApprovals.delete(requestId);
      }
    }
  }
  return {
    describe() {
      return {
        id: "claudecode",
        kind: "runtime",
        command: config.claudeCommand || "claude",
        sessionsFile: config.sessionsFile,
        ipcSocketPath: ipcConfig.displayPath,
        model: configuredModel,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      globalListener = listener;
      return () => {
        if (globalListener === listener) {
          globalListener = null;
        }
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities({ model = "" } = {}) {
      const effectiveModel = resolveModel(model);
      return {
        nativeImageInput: false,
        toolImageRead: hasClaudeImageFileRead(effectiveModel),
      };
    },
    async listAvailableModels() {
      if (
        availableModelCatalogCache
        && Date.now() - Date.parse(availableModelCatalogCache.updatedAt || "") < CLAUDE_MODEL_CATALOG_TTL_MS
      ) {
        return availableModelCatalogCache;
      }
      const gatewayConfig = resolveClaudeGatewayConfig({ claudeConfigDir: config.claudeConfigDir });
      if (!gatewayConfig.baseUrl || !gatewayConfig.authToken) {
        return availableModelCatalogCache;
      }
      try {
        const response = await fetchClaudeGatewayModels(gatewayConfig);
        const models = normalizeModelCatalog(response?.data);
        if (!models.length) {
          return availableModelCatalogCache;
        }
        availableModelCatalogCache = {
          models,
          updatedAt: new Date().toISOString(),
        };
        return availableModelCatalogCache;
      } catch {
        return availableModelCatalogCache;
      }
    },
    async initialize() {
      hydrateRuntimeModelsFromClaudeProjects();
      ipcServer.start();
      return {
        command: config.claudeCommand || "claude",
        models: [],
      };
    },
    async close() {
      for (const client of clientsByWorkspace.values()) {
        await client.close();
      }
      clientsByWorkspace.clear();
      await ipcServer.close();
    },
    async startFreshThreadDraft({ workspaceRoot }) {
      await closeWorkspaceClient(workspaceRoot);
      return { workspaceRoot };
    },
    async respondApproval({ requestId, decision, result = null }) {
      const workspaceRoot = pendingApprovals.get(requestId);
      const candidates = workspaceRoot
        ? [clientsByWorkspace.get(workspaceRoot)]
        : [...clientsByWorkspace.values()];
      for (const client of candidates) {
        if (client?.alive) {
          const responsePayload = result && typeof result === "object"
            ? result
            : { decision };
          await client.sendResponse(requestId, responsePayload);
          pendingApprovals.delete(requestId);
          return {
            requestId,
            ...(result && typeof result === "object"
              ? { result: responsePayload }
              : { decision: decision === "accept" ? "accept" : "decline" }),
          };
        }
      }
      throw new Error("no active claudecode session to respond to approval");
    },
    async cancelTurn({ threadId, turnId, workspaceRoot }) {
      if (workspaceRoot) {
        await closeWorkspaceClient(workspaceRoot);
        return { threadId, turnId };
      }
      for (const [workspaceRoot, client] of clientsByWorkspace.entries()) {
        if (client.sessionId === threadId) {
          await client.close();
          clientsByWorkspace.delete(workspaceRoot);
          return { threadId, turnId };
        }
      }
      return { threadId, turnId };
    },
    async resumeThread({ threadId, workspaceRoot, model = "" }) {
      if (!workspaceRoot) {
        return { threadId };
      }
      const attached = await attachClientToThread(workspaceRoot, threadId, model);
      return { threadId: attached.threadId };
    },
    async compactThread({ threadId, workspaceRoot, model = "" }) {
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId, model);
      await client.sendUserMessage({ text: "/compact", threadId: activeThreadId });
      return { threadId: activeThreadId, turnId: client.pendingTurnId };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId, model);
      const refreshText = buildInstructionRefreshText(config);
      await client.sendUserMessage({ text: refreshText, threadId: activeThreadId });
      return { threadId: activeThreadId };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "" }) {
      const desiredModel = resolveModel(model);
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (!threadId) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      if (desiredModel) {
        sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
          model: desiredModel,
          modelProvider: "",
        });
      }
      let openingTurn = !threadId;
      let attached;
      try {
        attached = await attachClientToThread(workspaceRoot, threadId, desiredModel);
      } catch (error) {
        if (!threadId) {
          throw error;
        }
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
        openingTurn = true;
        attached = await attachClientToThread(workspaceRoot, "", desiredModel);
      }
      const { client, threadId: activeThreadId } = attached;
      const outboundText = openingTurn ? buildOpeningTurnText(config, text) : text;
      const outboundThreadId = activeThreadId || threadId;
      if (outboundThreadId) {
        sessionStore.setThreadIdForWorkspace(
          bindingKey,
          workspaceRoot,
          outboundThreadId,
          metadata,
        );
      }
      await client.sendUserMessage({ text: outboundText, threadId: outboundThreadId });
      const returnedThreadId = outboundThreadId || normalizeThreadId(
        await client.waitForSessionId({ timeoutMs: CLAUDE_RESUME_SESSION_TIMEOUT_MS })
      );
      if (!returnedThreadId) {
        throw new Error("claudecode did not report a session id");
      }
      sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        returnedThreadId,
        metadata,
      );
      rememberModelForBinding(bindingKey, workspaceRoot, pendingModelByWorkspaceRoot.get(normalizeWorkspaceRoot(workspaceRoot)));
      return {
        threadId: returnedThreadId,
        turnId: client.pendingTurnId,
      };
    },
  };

  function hydrateRuntimeModelsFromClaudeProjects() {
    for (const binding of sessionStore.listBindings()) {
      const workspaceRoots = new Set([
        normalizeWorkspaceRoot(binding.activeWorkspaceRoot),
        ...sessionStore.listWorkspaceRoots(binding.bindingKey),
      ].filter(Boolean));
      for (const workspaceRoot of workspaceRoots) {
        const threadId = sessionStore.getThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
        const model = readLatestClaudeProjectModel({
          claudeConfigDir: config.claudeConfigDir,
          workspaceRoot,
          threadId,
        });
        rememberModelForBinding(binding.bindingKey, workspaceRoot, model);
      }
    }
  }

  function rememberObservedModelForWorkspace(workspaceRoot, model) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    const normalizedModel = normalizeClaudeRuntimeModel(model);
    if (!normalizedWorkspaceRoot || !normalizedModel) {
      return;
    }
    let remembered = false;
    for (const binding of sessionStore.listBindings()) {
      if (normalizeWorkspaceRoot(binding.activeWorkspaceRoot) === normalizedWorkspaceRoot) {
        rememberModelForBinding(binding.bindingKey, normalizedWorkspaceRoot, normalizedModel);
        remembered = true;
      }
    }
    if (!remembered) {
      pendingModelByWorkspaceRoot.set(normalizedWorkspaceRoot, normalizedModel);
    }
  }

  function rememberModelForBinding(bindingKey, workspaceRoot, model) {
    const normalizedModel = normalizeClaudeRuntimeModel(model);
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!bindingKey || !normalizedWorkspaceRoot || !normalizedModel) {
      return;
    }
    const current = sessionStore.getRuntimeParamsForWorkspace(bindingKey, normalizedWorkspaceRoot);
    if (normalizeText(current.model) === normalizedModel) {
      return;
    }
    sessionStore.setRuntimeParamsForWorkspace(bindingKey, normalizedWorkspaceRoot, {
      model: normalizedModel,
      modelProvider: "",
    });
  }
}

function filterClaudeCodeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== "CLAUDECODE") {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { createClaudeCodeRuntimeAdapter };

function normalizeThreadId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractClaudeMessageModel(raw) {
  return normalizeClaudeRuntimeModel(raw?.message?.model);
}

function normalizeClaudeRuntimeModel(model) {
  const normalized = normalizeText(model);
  if (!normalized || normalized === "<synthetic>") {
    return "";
  }
  return normalized;
}

function readLatestClaudeProjectModel({ claudeConfigDir = "", workspaceRoot = "", threadId = "" } = {}) {
  const transcriptPath = resolveClaudeProjectTranscriptPath({ claudeConfigDir, workspaceRoot, threadId });
  if (!transcriptPath) {
    return "";
  }
  let raw = "";
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const model = normalizeClaudeRuntimeModel(parsed?.message?.model);
      if (model) {
        return model;
      }
    } catch {
      // ignore malformed transcript lines
    }
  }
  return "";
}

function resolveClaudeProjectTranscriptPath({ claudeConfigDir = "", workspaceRoot = "", threadId = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedWorkspaceRoot || !normalizedThreadId) {
    return "";
  }
  const baseDir = normalizeText(claudeConfigDir) || path.join(os.homedir(), ".claude");
  return path.join(baseDir, "projects", encodeClaudeProjectPath(normalizedWorkspaceRoot), `${normalizedThreadId}.jsonl`);
}

function resolveClaudeGatewayConfig({ claudeConfigDir = "" } = {}) {
  const baseDir = normalizeText(claudeConfigDir) || path.join(os.homedir(), ".claude");
  const settings = readClaudeSettings(baseDir);
  const env = {
    ...(process.env || {}),
    ...(settings?.env && typeof settings.env === "object" ? settings.env : {}),
  };
  return {
    baseUrl: normalizeText(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL),
    authToken: normalizeText(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY),
  };
}

function readClaudeSettings(baseDir) {
  const settingsPath = path.join(baseDir, "settings.json");
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }
}

async function fetchClaudeGatewayModels({ baseUrl = "", authToken = "" } = {}) {
  const modelsUrl = buildClaudeModelsUrl(baseUrl);
  if (!modelsUrl || !authToken) {
    return { data: [] };
  }
  const response = await requestJson(modelsUrl, {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });
  const data = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.result?.data)
      ? response.result.data
      : [];
  return { data };
}

function buildClaudeModelsUrl(baseUrl) {
  const normalizedBaseUrl = normalizeText(baseUrl);
  if (!normalizedBaseUrl) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(normalizedBaseUrl);
  } catch {
    return "";
  }
  const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
  if (trimmedPath.endsWith("/v1/models")) {
    parsed.pathname = trimmedPath;
  } else if (trimmedPath.endsWith("/v1")) {
    parsed.pathname = `${trimmedPath}/models`;
  } else if (!trimmedPath || trimmedPath === "/") {
    parsed.pathname = "/v1/models";
  } else {
    parsed.pathname = `${trimmedPath}/v1/models`;
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function requestJson(url, { headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(parsed, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`claude model catalog request failed (${response.statusCode || 500})`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("claude model catalog request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

function encodeClaudeProjectPath(workspaceRoot) {
  return normalizeWorkspaceRoot(workspaceRoot).replace(/[\\/:\s]+/g, "-");
}

function hasClaudeImageFileRead(model) {
  const normalized = normalizeText(model).toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "sonnet"
    || normalized === "opus"
    || normalized === "haiku"
    || /\b(?:sonnet|opus|haiku)\b/.test(normalized)
    || /^claude-(?:3|4)(?:\b|-)/.test(normalized);
}

function clientMatchesThread(client, threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId || !client?.alive) {
    return false;
  }
  return normalizeThreadId(client.sessionId) === normalizedThreadId
    || normalizeThreadId(client.resumeSessionId) === normalizedThreadId;
}
