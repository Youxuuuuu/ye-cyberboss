const path = require("path");

function normalizeWorkspaceRoot(root) {
  const normalized = typeof root === "string" ? root.trim() : "";
  if (!normalized) {
    return "";
  }

  try {
    return path.resolve(normalized).replace(/\\/g, "/");
  } catch {
    return "";
  }
}

module.exports = { normalizeWorkspaceRoot };
