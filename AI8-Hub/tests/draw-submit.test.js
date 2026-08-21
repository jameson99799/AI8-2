"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const AI8Client = require("../lib/ai8-client");

test("submitDraw normalizes string images into base64 objects", async () => {
    const client = new AI8Client({ authToken: "token-1" });
    let captured = null;
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        captured = { url, options };
        return {
            ok: true,
            json: async () => ({ code: 0, data: { taskId: "t-1" }, msg: "" }),
        };
    };

    try {
        await client.submitDraw({
            model: "openai-draw",
            version: "gpt-image-2",
            prompt: "edit this",
            images: ["data:image/png;base64,AAAA"],
        });
    } finally {
        global.fetch = originalFetch;
    }

    assert.equal(String(captured.url), "https://ai8.rcouyi.com/api/draw");
    const body = JSON.parse(captured.options.body);
    assert.deepEqual(body.images, [{ base64: "data:image/png;base64,AAAA", name: "image-1.png" }]);
    assert.equal(body.action, "IMAGINE");
    assert.equal(body.args.version, "gpt-image-2");
});

test("submitDraw omits images field when none provided", async () => {
    const client = new AI8Client({ authToken: "token-1" });
    let captured = null;
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        captured = { url, options };
        return {
            ok: true,
            json: async () => ({ code: 0, data: { taskId: "t-2" }, msg: "" }),
        };
    };

    try {
        await client.submitDraw({ prompt: "a cat" });
    } finally {
        global.fetch = originalFetch;
    }

    const body = JSON.parse(captured.options.body);
    assert.equal(body.images, undefined);
});
