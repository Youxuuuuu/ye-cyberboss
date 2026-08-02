const assert = require("node:assert/strict");
const test = require("node:test");

const { reconcileModelCatalog } = require("../src/adapters/runtime/shared/model-catalog-reconciler");

test("a model is removed only after three consecutive successful refreshes omit it", () => {
  let catalog = {
    models: [
      { model: "model-a", displayName: "Model A" },
      { model: "model-b", displayName: "Model B" },
    ],
    missingSuccessCounts: {},
  };

  catalog = reconcileModelCatalog(catalog, [{ model: "model-a" }], {
    refreshedAt: "2026-07-31T00:00:01.000Z",
  });
  assert.deepEqual(catalog.models.map((item) => item.model), ["model-a", "model-b"]);
  assert.equal(catalog.missingSuccessCounts["model-b"], 1);

  catalog = reconcileModelCatalog(catalog, [{ model: "model-a" }], {
    refreshedAt: "2026-07-31T00:00:02.000Z",
  });
  assert.deepEqual(catalog.models.map((item) => item.model), ["model-a", "model-b"]);
  assert.equal(catalog.missingSuccessCounts["model-b"], 2);

  catalog = reconcileModelCatalog(catalog, [{ model: "model-a" }], {
    refreshedAt: "2026-07-31T00:00:03.000Z",
  });
  assert.deepEqual(catalog.models.map((item) => item.model), ["model-a"]);
  assert.equal(catalog.missingSuccessCounts["model-b"], undefined);
});

test("a reappearing model resets its missing-success count and refreshes its descriptor", () => {
  const catalog = reconcileModelCatalog({
    models: [
      { model: "model-a" },
      { model: "model-b", displayName: "Old B" },
    ],
    missingSuccessCounts: { "model-b": 2 },
  }, [
    { model: "model-b", displayName: "New B", provider: "provider-b" },
    { model: "model-a" },
  ], {
    refreshedAt: "2026-07-31T00:00:04.000Z",
  });

  assert.deepEqual(catalog.models.map((item) => item.model), ["model-b", "model-a"]);
  assert.equal(catalog.models[0].displayName, "New B");
  assert.equal(catalog.models[0].provider, "provider-b");
  assert.deepEqual(catalog.missingSuccessCounts, {});
  assert.equal(catalog.updatedAt, "2026-07-31T00:00:04.000Z");
});

test("the reconciler counts an empty response only after its caller has accepted the refresh as successful", () => {
  const catalog = reconcileModelCatalog({
    models: [{ model: "model-a" }],
    missingSuccessCounts: { "model-a": 1 },
  }, [], {
    refreshedAt: "2026-07-31T00:00:05.000Z",
  });

  assert.deepEqual(catalog.models.map((item) => item.model), ["model-a"]);
  assert.equal(catalog.missingSuccessCounts["model-a"], 2);
});
