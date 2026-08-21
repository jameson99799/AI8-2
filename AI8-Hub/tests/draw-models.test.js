"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    AI8_DRAW_MODELS,
    resolveDrawModel,
    sizeToAspectRatio,
    parseDrawVersionsFromChunk,
    classifyDrawProvider,
} = require("../lib/ai8-client");

test("parseDrawVersionsFromChunk extracts enum values from minified chunk", () => {
    const chunk = "var l=function(e){return e.VolcImg=`volc-img`,e.VolcText=`volc-text`,e.V5Lite=`volc-v5-lite`,e}({}),m=function(e){return e.GPTImage2=`gpt-image-2`,e.DallE3=`dall-e-3`,e}({});";
    const versions = parseDrawVersionsFromChunk(chunk);
    assert.ok(versions.includes("volc-img"));
    assert.ok(versions.includes("volc-text"));
    assert.ok(versions.includes("volc-v5-lite"));
    assert.ok(versions.includes("gpt-image-2"));
    assert.ok(versions.includes("dall-e-3"));
    assert.equal(versions.length, 5);
});

test("parseDrawVersionsFromChunk ignores action enums with Chinese values", () => {
    const chunk = "var c=function(e){return e.UPSCALE=`放大`,e.IMAGINE=`想象`,e}({});";
    const versions = parseDrawVersionsFromChunk(chunk);
    assert.equal(versions.length, 2);
    assert.equal(classifyDrawProvider("想象"), null);
});

test("classifyDrawProvider maps version prefixes to providers", () => {
    assert.equal(classifyDrawProvider("gpt-image-2"), "openai-draw");
    assert.equal(classifyDrawProvider("dall-e-3"), "openai-draw");
    assert.equal(classifyDrawProvider("nano-banana-pro"), "google-draw");
    assert.equal(classifyDrawProvider("grok-imagine-image-quality"), "xai-draw");
    assert.equal(classifyDrawProvider("qwen-image-2.0-pro"), "qwen-draw");
    assert.equal(classifyDrawProvider("wan2.7-image-pro"), "wan-draw");
    assert.equal(classifyDrawProvider("kling-kolors-v3"), "kling-draw");
    assert.equal(classifyDrawProvider("image-01-live"), "minimax-draw");
    assert.equal(classifyDrawProvider("volc-v5-pro"), "volc-draw");
    assert.equal(classifyDrawProvider("volc-text"), null);
    assert.equal(classifyDrawProvider("mj"), null);
    assert.equal(classifyDrawProvider(""), null);
});

test("sizeToAspectRatio reduces pixel sizes to aspect ratios", () => {
    assert.equal(sizeToAspectRatio("1024x1024"), "1:1");
    assert.equal(sizeToAspectRatio("1536x864"), "16:9");
    assert.equal(sizeToAspectRatio("864X1536"), "9:16");
    assert.equal(sizeToAspectRatio("auto"), null);
    assert.equal(sizeToAspectRatio(""), null);
});

test("resolveDrawModel matches static catalog case-insensitively", () => {
    assert.deepEqual(resolveDrawModel("GPT-Image-2"), { model: "openai-draw", version: "gpt-image-2" });
    assert.deepEqual(resolveDrawModel("gpt-image-2【AI8直连】"), { model: "openai-draw", version: "gpt-image-2" });
    assert.equal(resolveDrawModel("gpt-4o"), null);
    assert.equal(resolveDrawModel(""), null);
});

test("static AI8_DRAW_MODELS covers every provider", () => {
    const providers = new Set(AI8_DRAW_MODELS.map(m => m.model));
    for (const expected of ["openai-draw", "google-draw", "xai-draw", "qwen-draw", "wan-draw", "kling-draw", "minimax-draw", "volc-draw", "mj", "niji"]) {
        assert.ok(providers.has(expected), `missing provider ${expected}`);
    }
});
