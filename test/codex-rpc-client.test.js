const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { CodexRpcClient } = require("../src/adapters/runtime/codex/rpc-client");
const { mapCodexMessageToRuntimeEvent } = require("../src/adapters/runtime/codex/events");

test("codex token events separate cumulative totals from the latest context snapshot", () => {
  const event = mapCodexMessageToRuntimeEvent({
    type: "event_msg",
    payload: {
      type: "token_count",
      thread_id: "thread-1",
      info: {
        model_context_window: 200_000,
        total_token_usage: {
          input_tokens: 1_000,
          cached_input_tokens: 700,
          output_tokens: 100,
          reasoning_output_tokens: 25,
          total_tokens: 1_100,
        },
        last_token_usage: {
          input_tokens: 120,
          cached_input_tokens: 80,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 140,
        },
      },
    },
  });

  assert.deepEqual(event.payload.contextSnapshot, {
    runtimeId: "codex",
    threadId: "thread-1",
    inputTokens: 120,
    cachedInputTokens: 80,
    outputTokens: 20,
    reasoningTokens: 5,
    currentTokens: 140,
    contextWindow: 200_000,
  });
  assert.deepEqual(event.payload.usageObservation, {
    kind: "cumulative",
    runtimeId: "codex",
    threadId: "thread-1",
    total: {
      inputTokens: 1_000,
      cacheReadInputTokens: 700,
      outputTokens: 100,
    },
    last: {
      inputTokens: 120,
      cacheReadInputTokens: 80,
      outputTokens: 20,
    },
  });
});

test("codex token events use the adapter thread when the runtime payload omits thread_id", () => {
  const event = mapCodexMessageToRuntimeEvent({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1_000,
          cached_input_tokens: 700,
          output_tokens: 100,
        },
        last_token_usage: {
          input_tokens: 120,
          cached_input_tokens: 80,
          output_tokens: 20,
        },
      },
    },
  }, { threadId: "thread-from-adapter" });

  assert.equal(event.payload.threadId, "thread-from-adapter");
  assert.equal(event.payload.usageObservation.threadId, "thread-from-adapter");
});

test("codex rpc client uses turn/interrupt for stop requests", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };

  await client.cancelTurn({
    threadId: "thread-1",
    turnId: "turn-1",
  });

  assert.deepEqual(calls, [{
    method: "turn/interrupt",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  }]);
});

test("codex rpc client sends image attachments as local images", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { result: { turn: { id: "turn-1" } } };
  };

  await client.sendUserMessage({
    threadId: "thread-1",
    text: "what is this image?",
    attachments: [{
      absolutePath: path.join("/tmp", "cyberboss image.jpg"),
      contentType: "image/jpeg",
    }],
  });

  assert.equal(calls[0].method, "turn/start");
  assert.deepEqual(calls[0].params.input, [
    { type: "text", text: "what is this image?" },
    {
      type: "localImage",
      path: "/tmp/cyberboss image.jpg",
    },
  ]);
});
