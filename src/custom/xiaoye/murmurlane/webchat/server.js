const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { buildWebChatRequestFingerprint, normalizeWebChatSendContract } = require("./contract");
const { WebChatRequestLedger } = require("./request-ledger");

function createWebChatServer({ config, chatService, adapter }) {
  let server = null;
  const requestLedger = new WebChatRequestLedger({
    filePath: config.webChatRequestLedgerFile
      || path.join(path.resolve(config.stateDir || "."), "webchat-request-ledger.json"),
  });

  async function start() {
    if (config.webChatEnabled === false || server) {
      return server;
    }
    if (!isLoopbackHost(config.webChatHost) && !String(config.webChatToken || "").trim()) {
      throw new Error("CYBERBOSS_WEB_CHAT_TOKEN is required when the Web Chat host is not loopback");
    }
    server = http.createServer((request, response) => {
      void handleRequest(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendJson(response, Number(error?.statusCode) || 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server?.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      const configuredPort = Number(config.webChatPort);
      const port = Number.isFinite(configuredPort) && configuredPort >= 0
        ? configuredPort
        : 8791;
      server.listen(port, config.webChatHost || "127.0.0.1");
    });
    return server;
  }

  async function close() {
    if (!server) {
      return;
    }
    const current = server;
    server = null;
    current.closeAllConnections?.();
    await new Promise((resolve) => current.close(() => resolve()));
  }

  async function handleRequest(request, response) {
    applyCors(request, response, config.webChatAllowedOrigins);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/healthz") {
      if (!authorize(request, url, response, config.webChatToken)) return;
      sendJson(response, 200, {
        ok: true,
        service: "cyberboss-webchat",
        clients: adapter.getClientCount(),
      });
      return;
    }

    if (!url.pathname.startsWith("/api/chat/")) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    if (!authorize(request, url, response, config.webChatToken)) return;
    const identity = chatService.getWebChatIdentity();
    if (!identity?.senderId) {
      sendJson(response, 503, { error: "web chat sender is not configured" });
      return;
    }
    if (!isAllowedOrigin(request, config.webChatAllowedOrigins)) {
      sendJson(response, 403, { error: "origin is not allowed" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat/events") {
      const requestedSenderId = normalizeText(url.searchParams.get("senderId"));
      if (requestedSenderId && requestedSenderId !== identity.senderId) {
        sendJson(response, 403, { error: "sender is not allowed" });
        return;
      }
      adapter.subscribe(response, {
        senderId: identity.senderId,
        threadId: url.searchParams.get("threadId") || "",
        after: resolveEventAfter(
          url.searchParams.get("after"),
          request.headers["last-event-id"],
        ),
        clientId: url.searchParams.get("clientId") || "",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat/status") {
      const requestId = normalizeText(url.searchParams.get("requestId"));
      sendJson(response, 200, {
        ...chatService.getWebChatStatus({
        senderId: identity.senderId,
        threadId: url.searchParams.get("threadId") || "",
        }),
        ...(requestId ? { sendRequest: requestLedger.get(requestId) } : {}),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat/models") {
      sendJson(response, 200, await chatService.getWebChatModels({ senderId: identity.senderId }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat/media") {
      await serveMedia(url.searchParams.get("path") || "", response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/internal/file-deliveries") {
      const body = await readJsonBody(request, 1024 * 1024)
      const delivery = await normalizeInternalFileDelivery({
        body,
        identity,
        stateDir: config.stateDir,
      })
      await adapter.sendFile(delivery)
      sendJson(response, 202, { accepted: true })
      return
    }

    if (request.method === "POST" && url.pathname === "/api/chat/messages") {
      const body = await readJsonBody(request, requestBodyLimit(config));
      const contract = normalizeWebChatSendContract(body);
      const fingerprint = buildWebChatRequestFingerprint(contract, {
        threadId: body.threadId,
        newThread: body.newThread,
      });
      const result = await requestLedger.execute({
        requestId: contract.requestId,
        fingerprint,
        run: () => chatService.handleWebChatMessages({
          ...body,
          ...contract,
          senderId: identity.senderId,
        }),
      });
      sendJson(response, 202, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/uploads") {
      const bytes = await readBinaryBody(request, uploadBodyLimit(config));
      const media = await adapter.persistUpload({
        bytes,
        fileName: decodeUploadFileName(request.headers["x-cyberboss-file-name"]),
        contentType: normalizeText(request.headers["content-type"]) || "application/octet-stream",
        kind: normalizeText(request.headers["x-cyberboss-media-kind"]) || "file",
      });
      sendJson(response, 201, { accepted: true, media });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/model") {
      const body = await readJsonBody(request, 256 * 1024);
      sendJson(response, 200, await chatService.setWebChatModel({
        ...body,
        senderId: identity.senderId,
      }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/thread/select") {
      const body = await readJsonBody(request, 256 * 1024);
      sendJson(response, 200, await chatService.selectWebChatThread({
        ...body,
        senderId: identity.senderId,
      }));
      return;
    }

    sendJson(response, 404, { error: "not found" });
  }

  async function serveMedia(rawPath, response) {
    const stateRoot = path.resolve(config.stateDir);
    const candidate = String(rawPath || "").trim();
    if (!candidate) {
      sendJson(response, 400, { error: "media path is required" });
      return;
    }
    const target = path.resolve(path.isAbsolute(candidate) ? candidate : path.join(stateRoot, candidate));
    if (!isPathWithinRoot(target, stateRoot)) {
      sendJson(response, 403, { error: "media path is outside the state directory" });
      return;
    }
    let stat;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      sendJson(response, 404, { error: "media not found" });
      return;
    }
    if (!stat.isFile()) {
      sendJson(response, 404, { error: "media not found" });
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", mimeForPath(target));
    response.setHeader("Content-Length", stat.size);
    response.setHeader("Cache-Control", "private, max-age=3600");
    fs.createReadStream(target).on("error", () => response.destroy()).pipe(response);
  }

  return {
    start,
    close,
    requestLedger,
    address() { return server?.address?.() || null; },
  };
}

async function normalizeInternalFileDelivery({ body = {}, identity = {}, stateDir = "" } = {}) {
  const stateRoot = path.resolve(stateDir || ".")
  const requestedUserId = normalizeText(body.userId)
  const senderId = normalizeText(identity.senderId)
  if (requestedUserId && requestedUserId !== senderId) {
    const error = new Error("web chat delivery sender is not allowed")
    error.statusCode = 403
    throw error
  }

  const requestedPath = normalizeText(body.filePath || body.file?.path || body.file?.absolutePath)
  if (!requestedPath) {
    const error = new Error("web chat delivery file path is required")
    error.statusCode = 400
    throw error
  }
  const absolutePath = path.resolve(requestedPath)
  if (!isPathWithinRoot(absolutePath, stateRoot)) {
    const error = new Error("web chat delivery file is outside the state directory")
    error.statusCode = 403
    throw error
  }
  let stat
  try {
    stat = await fs.promises.stat(absolutePath)
  } catch {
    const error = new Error("web chat delivery file was not found")
    error.statusCode = 404
    throw error
  }
  if (!stat.isFile()) {
    const error = new Error("web chat delivery path is not a file")
    error.statusCode = 400
    throw error
  }

  const suppliedFile = body.file && typeof body.file === "object" && !Array.isArray(body.file)
    ? body.file
    : {}
  const file = {
    ...suppliedFile,
    path: absolutePath,
    absolutePath,
    relativePath: path.relative(stateRoot, absolutePath).replace(/\\/g, "/"),
    fileName: normalizeText(suppliedFile.fileName) || path.basename(absolutePath),
    contentType: normalizeText(suppliedFile.contentType) || mimeForPath(absolutePath).split(";")[0],
  }
  return {
    userId: senderId,
    filePath: absolutePath,
    threadId: normalizeText(body.threadId),
    turnId: normalizeText(body.turnId),
    itemId: normalizeText(body.itemId),
    messageId: normalizeText(body.messageId),
    requestId: normalizeText(body.requestId),
    logicalTurnId: normalizeText(body.logicalTurnId),
    displayTurnId: normalizeText(body.displayTurnId),
    transportTurnId: normalizeText(body.transportTurnId),
    canonicalTurnId: normalizeText(body.canonicalTurnId),
    file,
  }
}

function authorize(request, url, response, configuredToken = "") {
  const expected = normalizeText(configuredToken);
  if (!expected) {
    return true;
  }
  const authorization = normalizeText(request.headers.authorization);
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  const provided = bearer || normalizeText(request.headers["x-cyberboss-web-token"]) || normalizeText(url.searchParams.get("token"));
  if (provided === expected) {
    return true;
  }
  sendJson(response, 401, { error: "web chat authorization required" });
  return false;
}

function applyCors(request, response, allowedOrigins = []) {
  const origin = normalizeText(request.headers.origin);
  if (!origin) return;
  if (isAllowedOrigin(request, allowedOrigins)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Cyberboss-Web-Token, X-Cyberboss-File-Name, X-Cyberboss-Media-Kind");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
}

function isAllowedOrigin(request, allowedOrigins = []) {
  const origin = normalizeText(request.headers.origin);
  if (!origin) return true;
  const configured = Array.isArray(allowedOrigins) ? allowedOrigins.map(normalizeText).filter(Boolean) : [];
  if (configured.includes("*")) return true;
  if (configured.includes(origin)) return true;
  return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > maxBytes) {
        reject(new Error("request body is too large"));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error("request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function readBinaryBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        settled = true;
        const error = new Error(`upload exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(bytes);
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks, total));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function decodeUploadFileName(value) {
  const encoded = normalizeText(value);
  if (!encoded) return "attachment";
  try {
    return decodeURIComponent(encoded);
  } catch {
    const error = new Error("upload file name header must be URI encoded");
    error.statusCode = 400;
    throw error;
  }
}

function uploadBodyLimit(config) {
  return Number(config.webChatMaxUploadBytes) || 25 * 1024 * 1024;
}

function requestBodyLimit(config) {
  const maxUploadBytes = Number(config.webChatMaxUploadBytes) || 25 * 1024 * 1024;
  return Math.min(Math.max(Math.ceil(maxUploadBytes * 1.8), 2 * 1024 * 1024), 60 * 1024 * 1024);
}

function sendJson(response, statusCode, payload) {
  if (response.headersSent) return;
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isPathWithinRoot(candidate, root) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function mimeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
  }[extension] || "application/octet-stream";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveEventAfter(queryAfter, lastEventId) {
  const queryCursor = Number(queryAfter);
  const reconnectCursor = Number(lastEventId);
  return Math.max(
    Number.isFinite(queryCursor) && queryCursor >= 0 ? queryCursor : 0,
    Number.isFinite(reconnectCursor) && reconnectCursor >= 0 ? reconnectCursor : 0,
  );
}

module.exports = { createWebChatServer, resolveEventAfter };
