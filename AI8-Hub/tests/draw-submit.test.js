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
    assert.equal(body.args.area, "auto");
    assert.equal(body.args.quality, "high");
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

test("submitDraw builds google-draw args matching official client", async () => {
    const client = new AI8Client({ authToken: "token-1" });
    let captured = null;
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
        captured = { url, options };
        return {
            ok: true,
            json: async () => ({ code: 0, data: { taskId: "t-3" }, msg: "" }),
        };
    };

    try {
        await client.submitDraw({
            model: "google-draw",
            version: "nano-banana-pro",
            prompt: "edit",
            images: ["data:image/png;base64,AAAA"],
        });
    } finally {
        global.fetch = originalFetch;
    }

    const body = JSON.parse(captured.options.body);
    assert.equal(body.model, "google-draw");
    assert.deepEqual(body.args, {
        version: "nano-banana-pro",
        resolution: "2K",
        area: "auto",
        images: [{ base64: "data:image/png;base64,AAAA", name: "image-1.png", size: 3 }],
    });
});

test("buildDrawArgs forces 1K resolution for nano-banana lite versions", () => {
    const { buildDrawArgs } = require("../lib/ai8-client");

    const lite = buildDrawArgs({ model: "google-draw", version: "nano-banana-2-lite", size: "auto", images: [] });
    assert.equal(lite.resolution, "1K");
    assert.equal(lite.area, "auto");

    const pro = buildDrawArgs({ model: "google-draw", version: "nano-banana-2", size: "auto", images: [] });
    assert.equal(pro.resolution, "2K");
});

test("buildDrawArgs maps refImg for qwen/volc/wan/minimax/kling", () => {
    const { buildDrawArgs } = require("../lib/ai8-client");
    const images = [{ base64: "data:x", name: "a.png", size: 1 }];

    const qwen = buildDrawArgs({ model: "qwen-draw", version: "qwen-image-2.0-pro", size: "1024x1024", outputMax: 1, quality: "high", images });
    assert.deepEqual(qwen.refImg, images);
    assert.equal(qwen.area, "2048*2048");
    assert.equal(qwen.prompt_extend, true);

    const volc = buildDrawArgs({ model: "volc-draw", version: "volc-v5-pro", size: "1024x1024", outputMax: 1, quality: "high", images });
    assert.deepEqual(volc.refImg, images);
    assert.equal(volc.resolution, "2K");
    assert.equal(volc.output_format, "jpeg");

    const minimax = buildDrawArgs({ model: "minimax-draw", version: "image-01", size: "1536x864", outputMax: 1, quality: "high", images });
    assert.deepEqual(minimax.refImg, images);
    assert.equal(minimax.aspect_ratio, "16:9");

    const kling = buildDrawArgs({ model: "kling-draw", version: "kling-kolors-v3", size: "1024x1024", outputMax: 1, quality: "high", images });
    assert.deepEqual(kling.refImg, images);
    assert.equal(kling.aspect_ratio, "1:1");

    const wan = buildDrawArgs({ model: "wan-draw", version: "wan2.7-image-pro", size: "1024x1024", outputMax: 1, quality: "high", images });
    assert.deepEqual(wan.refImg, images);
    assert.equal(wan.area, "1280*1280");
    assert.equal(wan.thinking_mode, true);
});
