"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const FreeGptClient = require("../lib/freegpt-client");

function createClient() {
    return new FreeGptClient({
        uuid: "test-uuid-123",
        baseUrl: "https://chat1.freegpt.work",
        clientIp: "1.2.3.4",
        defaultModel: "gpt-4o-mini",
    });
}

function makeChallenge() {
    return {
        challengeId: "challenge-id-123",
        challenge: "challenge-id-123.secret-part.msslaaaa",
        difficulty: 2,
        issuedAt: 1786699999000,
        expiresAt: 1786700299000,
        algorithm: "sha256-prefix",
        version: "1.0",
    };
}

function makeJsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => (name.toLowerCase() === "content-type" ? "application/json" : null) },
        text: async () => JSON.stringify(payload),
        json: async () => payload,
    };
}

function makeStreamResponse(bodyText, status = 200) {
    const encoder = new TextEncoder();
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
        text: async () => bodyText,
        json: async () => { throw new Error("not json"); },
        body: (function* () {
            for (let i = 0; i < bodyText.length; i += 32) {
                yield encoder.encode(bodyText.slice(i, i + 32));
            }
        })(),
    };
}

function sseResponse(chunks) {
    const lines = [": stream-start"];
    for (const chunk of chunks) {
        lines.push(`data: ${JSON.stringify(chunk)}`);
    }
    lines.push("data: [DONE]");
    return lines.join("\n\n") + "\n\n";
}

test("FreeGptClient requires a uuid", () => {
    assert.throws(() => new FreeGptClient({ baseUrl: "https://chat1.freegpt.work" }), /FREEGPT_UUID is required/);
});

test("fetchModels flattens the models endpoint and skips unavailable models", async () => {
    const client = createClient();
    client._fetch = async () => makeJsonResponse({
        success: true,
        data: [
            { id: "gpt-4o-mini", name: "GPT-4o Mini", available: true },
            { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", available: true },
            { id: "gpt-5.5", name: "GPT-5.5", available: false },
        ],
    });

    const models = await client.fetchModels();
    assert.equal(models.length, 2);
    assert.equal(models[0].value, "gpt-4o-mini");
    assert.equal(models[1].value, "gpt-5.4-mini");
});

test("resolveModel matches full id and short name", async () => {
    const client = createClient();
    client.fetchModels = async () => [
        { value: "gpt-4o-mini", label: "GPT-4o Mini" },
        { value: "provider/gpt-5.4-mini", label: "GPT-5.4 Mini" },
    ];

    assert.deepEqual(await client.resolveModel("provider/gpt-5.4-mini"), { value: "provider/gpt-5.4-mini", label: "GPT-5.4 Mini" });
    assert.deepEqual(await client.resolveModel("gpt-5.4-mini"), { value: "provider/gpt-5.4-mini", label: "GPT-5.4 Mini" });
    await assert.rejects(() => client.resolveModel("nope"), /was not found on freegpt/);
});

test("streamChatCompletion parses SSE chunks and accumulates content", async () => {
    const client = createClient();
    client.resolveModel = async () => ({ value: "gpt-4o-mini", label: "GPT-4o Mini" });
    client._getChallenge = async () => makeChallenge();

    const body = sseResponse([
        { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
        { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
        { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);

    let upstreamUrl = "";
    client._fetch = async (path, options) => {
        upstreamUrl = path;
        assert.equal(options.method, "POST");
        return makeStreamResponse(body);
    };

    const onText = [];
    const onObject = [];
    let done = false;
    const result = await client.streamChatCompletion({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }, {
        onText(delta) { onText.push(delta); },
        onObject(obj) { onObject.push(obj); },
        onDone() { done = true; },
    });

    assert.equal(upstreamUrl, "/api/openai/oneapi/v1/chat/completions");
    assert.equal(result.content, "Hello");
    assert.deepEqual(onText.join(""), "Hello");
    assert.equal(onObject.length, 3);
    assert.equal(done, true);
});

test("streamChatCompletion normalizes upstream errors to an Error with status", async () => {
    const client = createClient();
    client.resolveModel = async () => ({ value: "gpt-4o-mini", label: "GPT-4o Mini" });
    client._getChallenge = async () => makeChallenge();
    client._fetch = async () => makeJsonResponse({ error: { message: "今日免费次数已用完" } }, 429);

    await assert.rejects(
        () => client.streamChatCompletion({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
        error => error.status === 429
    );
});

test("_fetch sends content-type application/json when a JSON body is present", async () => {
    const client = createClient();
    let seenHeaders = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        seenHeaders = init.headers;
        return makeJsonResponse({ success: true, data: [] });
    };
    try {
        await client._fetch("/api/openai/oneapi/v1/models", { body: { stream: true } });
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(seenHeaders["content-type"], "application/json");
    assert.equal(seenHeaders.uuid, "test-uuid-123");
});

test("streamChatCompletion refreshes the challenge and retries once on a secure 401", async () => {
    const client = createClient();
    client.resolveModel = async () => ({ value: "gpt-4o-mini", label: "GPT-4o Mini" });
    let refreshCalls = 0;
    client._getChallenge = async ({ forceRefresh } = {}) => {
        if (forceRefresh) refreshCalls++;
        return makeChallenge();
    };

    const body = sseResponse([
        { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] },
        { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);

    let calls = 0;
    client._fetch = async (path, options) => {
        calls++;
        if (calls === 1) {
            return makeJsonResponse({ error: { message: "signature expired" } }, 401);
        }
        return makeStreamResponse(body);
    };

    const result = await client.streamChatCompletion({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    assert.equal(calls, 2);
    assert.equal(refreshCalls, 3);
    assert.equal(result.content, "Hi");
});

test("streamChatCompletion does not retry on a non-secure 401 (invalid token)", async () => {
    const client = createClient();
    client.resolveModel = async () => ({ value: "gpt-4o-mini", label: "GPT-4o Mini" });
    client._getChallenge = async () => makeChallenge();

    let calls = 0;
    client._fetch = async (path, options) => {
        calls++;
        return makeJsonResponse({ error: { message: "无效的令牌，你可能需要订阅" } }, 401);
    };

    await assert.rejects(
        () => client.streamChatCompletion({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
        error => error.status === 401
    );
    assert.equal(calls, 1);
});