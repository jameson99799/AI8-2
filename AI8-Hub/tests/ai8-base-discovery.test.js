"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const AI8Client = require("../lib/ai8-client");

const SITE_ORIGIN = "https://example.com";
const GATEWAY_ORIGIN = "https://api-abc123.example.com";

function htmlResponse(body) {
    return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function jsonResponse(body) {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function withMockFetch(t, handler) {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options = {}) => {
        const target = String(url);
        calls.push({ url: target, options });
        return handler(target, options);
    };
    t.after(() => {
        global.fetch = originalFetch;
    });
    return calls;
}

test("retries against the discovered API gateway when the configured base serves HTML", async (t) => {
    const client = new AI8Client({ authToken: "token-1", baseUrl: `${SITE_ORIGIN}/api` });
    const calls = withMockFetch(t, target => {
        if (target === `${SITE_ORIGIN}/api/chat/tmpl`) {
            return htmlResponse("<!DOCTYPE html><html><body>app shell</body></html>");
        }
        if (target === `${SITE_ORIGIN}/`) {
            return htmlResponse('<html><body><script src="/assets/app-abc.js"></script></body></html>');
        }
        if (target === `${SITE_ORIGIN}/assets/app-abc.js`) {
            return new Response(`const config={api:"${GATEWAY_ORIGIN}/api"};`, {
                status: 200,
                headers: { "content-type": "application/javascript" },
            });
        }
        if (target === `${GATEWAY_ORIGIN}/api/chat/tmpl`) {
            return jsonResponse({ code: 0, data: { models: [{ label: "M1", value: "openai_chat::m1" }] } });
        }
        return new Response("not found", { status: 404 });
    });

    const models = await client.fetchModels();
    assert.deepEqual(models, [{ label: "M1", value: "openai_chat::m1" }]);

    // The recovered gateway is reused, so later calls go straight to it.
    const before = calls.length;
    const forced = await client.fetchModels({ forceRefresh: true });
    assert.deepEqual(forced, [{ label: "M1", value: "openai_chat::m1" }]);
    const newCalls = calls.slice(before);
    assert.ok(newCalls.every(call => call.url.startsWith(GATEWAY_ORIGIN)), JSON.stringify(newCalls.map(c => c.url)));
});

test("reports a non-JSON response and stops retrying discovery after a failure", async (t) => {
    const client = new AI8Client({ authToken: "token-1", baseUrl: `${SITE_ORIGIN}/api` });
    const calls = withMockFetch(t, target => {
        if (target === `${SITE_ORIGIN}/api/chat/tmpl`) {
            return htmlResponse("<!DOCTYPE html><html><body>no gateway here</body></html>");
        }
        if (target === `${SITE_ORIGIN}/`) {
            return htmlResponse("<html><body>no scripts</body></html>");
        }
        return new Response("not found", { status: 404 });
    });

    await assert.rejects(client.fetchModels(), /non-JSON response/);

    const siteFetchesAfterFirst = calls.filter(call => call.url === `${SITE_ORIGIN}/`).length;
    assert.equal(siteFetchesAfterFirst, 1);

    // The cooldown prevents hammering the site on every failed request.
    await assert.rejects(client.fetchModels(), /non-JSON response/);
    assert.equal(calls.filter(call => call.url === `${SITE_ORIGIN}/`).length, 1);
});

test("does not probe the site when the configured API already answers with JSON", async (t) => {
    const client = new AI8Client({ authToken: "token-1", baseUrl: `${SITE_ORIGIN}/api` });
    const calls = withMockFetch(t, target => {
        if (target === `${SITE_ORIGIN}/api/chat/tmpl`) {
            return jsonResponse({ code: 0, data: { models: [] } });
        }
        return new Response("unexpected", { status: 500 });
    });

    assert.deepEqual(await client.fetchModels(), []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${SITE_ORIGIN}/api/chat/tmpl`);
});
