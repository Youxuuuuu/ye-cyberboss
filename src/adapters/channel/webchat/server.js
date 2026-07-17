const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

function createWebChatServer({ config, app, adapter }) {
  let server = null;

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
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
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
      server.listen(Number(config.webChatPort) || 8791, config.webChatHost || "127.0.0.1");
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
    const identity = app.getWebChatIdentity();
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
        after: url.searchParams.get("after") || request.headers["last-event-id"] || 0,
        clientId: url.searchParams.get("clientId") || "",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat/status") {
      sendJson(response, 200, app.getWebChatStatus({
        senderId: identity.senderId,
        threadId: url.searchParams.get("threadId") || "",
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat/models") {
      sendJson(response, 200, await app.getWebChatModels({ senderId: identity.senderId }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat/media") {
      await serveMedia(url.searchParams.get("path") || "", response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/messages") {
      const body = await readJsonBody(request, requestBodyLimit(config));
      const result = await app.handleWebChatMessages({
        ...body,
        senderId: identity.senderId,
      });
      sendJson(response, 202, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/uploads") {
      const body = await readJsonBody(request, requestBodyLimit(config));
      const media = await adapter.persistUpload(body);
      sendJson(response, 201, { accepted: true, media });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/model") {
      const body = await readJsonBody(request, 256 * 1024);
      sendJson(response, 200, await app.setWebChatModel({
        ...body,
        senderId: identity.senderId,
      }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat/thread/select") {
      const body = await readJsonBody(request, 256 * 1024);
      sendJson(response, 200, await app.selectWebChatThread({
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

  return { start, close };
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
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Cyberboss-Web-Token");
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

module.exports = { createWebChatServer };
