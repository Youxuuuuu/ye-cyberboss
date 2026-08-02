const assert = require("node:assert/strict");
const test = require("node:test");

const { RuntimeModelCatalog } = require("../src/adapters/runtime/shared/runtime-model-catalog");

test("a stale last-known-good catalog is returned immediately while one refresh runs", async () => {
  let resolveFetch;
  let fetchCount = 0;
  const stored = {
    models: [{ model: "model-a" }],
    updatedAt: "2026-07-31T00:00:00.000Z",
    missingSuccessCounts: {},
  };
  const sessionStore = {
    getAvailableModelCatalog() {
      return stored;
    },
    setAvailableModelCatalog(models, metadata) {
      stored.models = models;
      stored.updatedAt = metadata.updatedAt;
      stored.missingSuccessCounts = metadata.missingSuccessCounts;
      return { ...stored };
    },
  };
  const catalog = new RuntimeModelCatalog({
    sessionStore,
    ttlMs: 1,
    now: () => Date.parse("2026-07-31T00:01:00.000Z"),
    retryDelaysMs: [],
    fetchModels: () => {
      fetchCount += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  });

  const first = await catalog.list();
  const second = await catalog.list();
  assert.deepEqual(first.models.map((item) => item.model), ["model-a"]);
  assert.equal(first.refreshing, true);
  assert.equal(second.refreshing, true);
  assert.equal(fetchCount, 1);

  resolveFetch([{ model: "model-b" }]);
  await catalog.waitForRefresh();
  assert.deepEqual((await catalog.list()).models.map((item) => item.model), ["model-b", "model-a"]);
});

test("the first catalog load waits for a finite retry sequence and exposes a safe error", async () => {
  let fetchCount = 0;
  const sessionStore = {
    getAvailableModelCatalog() { return null },
    setAvailableModelCatalog() { throw new Error("must not persist a failed refresh") },
  };
  const catalog = new RuntimeModelCatalog({
    sessionStore,
    retryDelaysMs: [0, 0],
    fetchModels: async () => {
      fetchCount += 1;
      throw new Error("secret gateway details");
    },
  });

  const result = await catalog.list();
  assert.equal(fetchCount, 3);
  assert.deepEqual(result.models, []);
  assert.equal(result.refreshing, false);
  assert.equal(result.stale, true);
  assert.equal(result.error, "模型目录暂时无法刷新");
  assert.equal(result.canRetry, true);
});

test("an empty refresh is treated as suspicious and preserves the last-known-good catalog", async () => {
  let fetchCount = 0;
  let persistCount = 0;
  const stored = {
    models: [{ model: "model-a" }],
    updatedAt: "2026-07-31T00:00:00.000Z",
    missingSuccessCounts: { "model-a": 1 },
  };
  const sessionStore = {
    getAvailableModelCatalog() {
      return stored;
    },
    setAvailableModelCatalog() {
      persistCount += 1;
    },
  };
  const catalog = new RuntimeModelCatalog({
    sessionStore,
    ttlMs: 1,
    now: () => Date.parse("2026-07-31T00:01:00.000Z"),
    retryDelaysMs: [0, 0],
    fetchModels: async () => {
      fetchCount += 1;
      return [];
    },
  });

  const stale = await catalog.list();
  assert.deepEqual(stale.models.map((item) => item.model), ["model-a"]);
  await catalog.waitForRefresh();

  const result = catalog.buildSnapshot(stored);
  assert.equal(fetchCount, 3);
  assert.equal(persistCount, 0);
  assert.deepEqual(result.models.map((item) => item.model), ["model-a"]);
  assert.deepEqual(result.missingSuccessCounts, { "model-a": 1 });
  assert.equal(result.error, "模型目录暂时无法刷新");
  assert.equal(result.canRetry, true);
});

test("a caller may keep its visible LKG while waiting for one refreshed snapshot", async () => {
  const stored = {
    models: [{ model: "model-a" }],
    updatedAt: "2026-07-31T00:00:00.000Z",
    missingSuccessCounts: {},
  };
  const sessionStore = {
    getAvailableModelCatalog() {
      return stored;
    },
    setAvailableModelCatalog(models, metadata) {
      stored.models = models;
      stored.updatedAt = metadata.updatedAt;
      stored.missingSuccessCounts = metadata.missingSuccessCounts;
    },
  };
  const catalog = new RuntimeModelCatalog({
    sessionStore,
    now: () => Date.parse("2026-07-31T00:01:00.000Z"),
    retryDelaysMs: [],
    fetchModels: async () => [{ model: "model-b" }],
  });

  const result = await catalog.list({
    refresh: true,
    waitForRefresh: true,
  });

  assert.deepEqual(result.models.map((item) => item.model), ["model-b", "model-a"]);
  assert.equal(result.refreshing, false);
  assert.equal(result.error, "");
});

test("a suspicious partial catalog gets finite retries but counts omissions only once", async () => {
  let fetchCount = 0;
  const stored = {
    models: [{ model: "model-a" }, { model: "model-b" }],
    updatedAt: "2026-07-31T00:00:00.000Z",
    missingSuccessCounts: {},
  };
  const sessionStore = {
    getAvailableModelCatalog() {
      return stored;
    },
    setAvailableModelCatalog(models, metadata) {
      stored.models = models;
      stored.updatedAt = metadata.updatedAt;
      stored.missingSuccessCounts = metadata.missingSuccessCounts;
    },
  };
  const catalog = new RuntimeModelCatalog({
    sessionStore,
    now: () => Date.parse("2026-07-31T00:01:00.000Z"),
    retryDelaysMs: [0, 0],
    fetchModels: async () => {
      fetchCount += 1;
      return [{ model: "model-b" }];
    },
  });

  const result = await catalog.list({
    refresh: true,
    waitForRefresh: true,
  });

  assert.equal(fetchCount, 3);
  assert.deepEqual(result.models.map((item) => item.model), ["model-b", "model-a"]);
  assert.deepEqual(result.missingSuccessCounts, { "model-a": 1 });
});

test("a complete retry replaces a suspicious partial candidate without recording a miss", async () => {
  let fetchCount = 0;
  const stored = {
    models: [{ model: "model-a" }, { model: "model-b" }],
    updatedAt: "2026-07-31T00:00:00.000Z",
    missingSuccessCounts: {},
  };
  const sessionStore = {
    getAvailableModelCatalog() {
      return stored;
    },
    setAvailableModelCatalog(models, metadata) {
      stored.models = models;
      stored.updatedAt = metadata.updatedAt;
      stored.missingSuccessCounts = metadata.missingSuccessCounts;
    },
  };
  const catalog = new RuntimeModelCatalog({
    sessionStore,
    now: () => Date.parse("2026-07-31T00:01:00.000Z"),
    retryDelaysMs: [0, 0],
    fetchModels: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? [{ model: "model-b" }]
        : [{ model: "model-a" }, { model: "model-b" }];
    },
  });

  const result = await catalog.list({
    refresh: true,
    waitForRefresh: true,
  });

  assert.equal(fetchCount, 2);
  assert.deepEqual(result.models.map((item) => item.model), ["model-a", "model-b"]);
  assert.deepEqual(result.missingSuccessCounts, {});
});
