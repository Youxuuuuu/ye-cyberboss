const http = require("http");
const {
  listenUrl,
  appServerPidFile,
  bridgePidFile,
  readPidFile,
  isPidAlive,
  isSharedBridgeHealthy,
} = require("./shared-common");

async function main() {
  const runtime = process.env.CYBERBOSS_RUNTIME || "codex";
  const isCodex = runtime === "codex";
  console.log(`runtime=${runtime}`);
  console.log(`listen=${listenUrl}`);
  if (!isCodex) {
    console.log("shared_app_server_pid=skipped");
  } else {
    printPidState("shared_app_server_pid", appServerPidFile);
  }
  await printPidState("shared_cyberboss_pid", bridgePidFile, { runtime });
  if (!isCodex) {
    console.log(`readyz=skipped`);
  } else {
    console.log(`readyz=${await checkReadyz() ? "ok" : "down"}`);
  }
}

async function printPidState(label, filePath, { runtime = "" } = {}) {
  const pid = readPidFile(filePath);
  if (!pid) {
    console.log(`${label}=missing`);
    return;
  }
  if (label === "shared_cyberboss_pid" && !(await isSharedBridgeHealthy(pid, runtime))) {
    console.log(`${label}=stale`);
    return;
  }
  if (!isPidAlive(pid)) {
    console.log(`${label}=stale`);
    return;
  }
  console.log(`${label}=${pid}`);
}

function checkReadyz() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: new URL(listenUrl).port,
        path: "/readyz",
        timeout: 600,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
