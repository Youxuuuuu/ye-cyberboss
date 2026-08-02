const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

test("handleModelCommand shows the runtime-provided model catalog for claudecode", async () => {
  const sent = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      async listAvailableModels() {
        return {
          models: [
            { model: "deepseek-v4-flash" },
            { model: "sensenova-6.7-flash-lite" },
          ],
          updatedAt: "2026-06-17T04:00:00.000Z",
        };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getAvailableModelCatalog() {
            return {
              models: [{ model: "gpt-5.5" }],
              updatedAt: "2026-06-17T03:00:00.000Z",
            };
          },
          getRuntimeParamsForWorkspace() {
            return {
              model: "deepseek-v4-flash",
              modelProvider: "",
            };
          },
        };
      },
    },
    runtimeSettingsService: {
      async getWorkspaceSettings() {
        return {
          currentModel: "deepseek-v4-flash",
          models: [
            { model: "deepseek-v4-flash" },
            { model: "sensenova-6.7-flash-lite" },
          ],
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CyberbossApp.prototype.handleModelCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "",
  });

  assert.equal(
    sent[0],
    "Current model: deepseek-v4-flash\nAvailable models: deepseek-v4-flash, sensenova-6.7-flash-lite"
  );
});

test("handleModelCommand rejects an unverified claudecode model when the catalog is unavailable", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      async listAvailableModels() {
        return null;
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getRuntimeParamsForWorkspace() {
            return {
              model: "deepseek-v4-flash",
              modelProvider: "",
            };
          },
          setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, params) {
            calls.push(["set", bindingKey, workspaceRoot, params]);
          },
        };
      },
    },
    runtimeSettingsService: {
      async getWorkspaceSettings() {
        return {
          currentModel: "deepseek-v4-flash",
          models: [],
        };
      },
      async updateWorkspaceSettings() {
        const error = new Error("model not found");
        error.code = "MODEL_NOT_FOUND";
        throw error;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CyberbossApp.prototype.handleModelCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "glm-4.6v",
  });

  assert.deepEqual(calls, [
    ["send", "❌ Model not found\nglm-4.6v"],
  ]);
});
