"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildAdminModelsList,
    buildModelsList,
    toDisplayModelId,
} = require("../lib/openai-format");

test("toDisplayModelId strips provider prefix from AI8 model ids", () => {
    assert.equal(toDisplayModelId("openai_chat::gpt-5.4-nano"), "gpt-5.4-nano");
    assert.equal(toDisplayModelId("gpt-5.4-mini"), "gpt-5.4-mini");
});

test("buildModelsList returns short ids for OpenAI-compatible model listing", () => {
    const payload = buildModelsList([
        {
            attr: {
                providerName: "OpenAI",
            },
            value: "openai_chat::gpt-5.4-nano",
        },
    ]);

    assert.equal(payload.object, "list");
    assert.equal(payload.data[0].id, "gpt-5.4-nano");
    assert.equal(payload.data[0].owned_by, "OpenAI");
});

test("buildAdminModelsList keeps raw model ids while exposing short display values", () => {
    const payload = buildAdminModelsList([
        {
            attr: {
                providerName: "OpenAI",
            },
            label: "GPT 5.4 Nano",
            value: "openai_chat::gpt-5.4-nano",
        },
    ]);

    assert.equal(payload[0].value, "openai_chat::gpt-5.4-nano");
    assert.equal(payload[0].display_value, "gpt-5.4-nano");
    assert.equal(payload[0].label, "GPT 5.4 Nano");
});
