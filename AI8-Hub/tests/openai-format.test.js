"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildAdminModelsList,
    buildChatCompletion,
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

test("buildModelsList keeps the channel tag in id and name", () => {
    const payload = buildModelsList([
        {
            attr: { providerName: "ai8" },
            label: "gpt-image-2【AI8直连】",
            origId: "gpt-image-2",
            value: "gpt-image-2【AI8直连】",
        },
        {
            attr: { providerName: "ai8" },
            label: "gpt-4.1-mini【AI8直连】",
            origId: "openai_chat::gpt-4.1-mini",
            value: "openai_chat::gpt-4.1-mini【AI8直连】",
        },
        {
            attr: { providerName: "ouyi" },
            label: "gpt-4o【ouyi】",
            origId: "gpt-4o",
            value: "gpt-4o【ouyi】",
        },
    ]);

    assert.equal(payload.data[0].id, "gpt-image-2【AI8直连】");
    assert.equal(payload.data[0].name, "gpt-image-2【AI8直连】");
    assert.equal(payload.data[1].id, "gpt-4.1-mini【AI8直连】");
    assert.equal(payload.data[1].name, "gpt-4.1-mini【AI8直连】");
    assert.equal(payload.data[2].id, "gpt-4o【ouyi】");
    assert.equal(payload.data[2].name, "gpt-4o【ouyi】");
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

test("buildChatCompletion attaches tool_calls and flips finish_reason to tool_calls", () => {
    const payload = buildChatCompletion({
        content: "",
        created: 123,
        id: "chatcmpl-1",
        model: "gpt-5-nano",
        toolCalls: [
            {
                index: 0,
                id: "call_0",
                type: "function",
                function: {
                    name: "get_weather",
                    arguments: '{"city":"北京"}',
                },
            },
        ],
    });

    assert.equal(payload.choices[0].finish_reason, "tool_calls");
    assert.equal(payload.choices[0].message.content, "");
    assert.equal(payload.choices[0].message.tool_calls[0].function.name, "get_weather");
});

test("buildChatCompletion stays on finish_reason stop without tool calls", () => {
    const payload = buildChatCompletion({
        content: "hello",
        created: 123,
        id: "chatcmpl-1",
        model: "gpt-5-nano",
    });

    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.equal(payload.choices[0].message.tool_calls, undefined);
});
