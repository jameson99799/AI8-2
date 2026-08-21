"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const AI8Client = require("../lib/ai8-client");
const { parseDrawImageEntry, getImageDimensions } = require("../lib/ai8-client");

function makePngBuffer(width, height) {
    const buffer = Buffer.alloc(24);
    buffer.writeUInt32BE(0x89504e47, 0);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

test("getImageDimensions parses PNG header", () => {
    const dims = getImageDimensions(makePngBuffer(1279, 1706));
    assert.deepEqual(dims, { width: 1279, height: 1706 });
});

test("parseDrawImageEntry builds metadata object from data url", () => {
    const png = makePngBuffer(10, 20);
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const entry = parseDrawImageEntry(dataUrl, 0);
    assert.equal(entry.base64, dataUrl);
    assert.equal(entry.name, "image-1.png");
    assert.equal(entry.size, png.length);
    assert.equal(entry.width, 10);
    assert.equal(entry.height, 20);
});

test("parseDrawImageEntry returns null for non-data-url input", () => {
    assert.equal(parseDrawImageEntry("https://example.com/a.png", 0), null);
});

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
    assert.deepEqual(body.args.images, [{ base64: "data:image/png;base64,AAAA", name: "image-1.png", size: 3 }]);
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
    assert.equal(body.args.images, undefined);
});
