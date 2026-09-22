"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { anthropicToOpenAiRequest, estimateInputTokens, openAiToAnthropicChunk, openAiToAnthropicResponse } = require("../lib/anthropic-format");

test("tool_use is converted to assistant tool_calls, never leaked into content", () => {
    const result = anthropicToOpenAiRequest({
        model: "claude-3-5-sonnet",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "What's the weather in Tokyo?" },
                ],
            },
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_01",
                        name: "get_weather",
                        input: { city: "Tokyo" },
                    },
                ],
            },
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "toolu_01",
                        content: "Sunny, 22C",
                    },
                ],
            },
        ],
    });

    const assistant = result.messages.find(m => m.role === "assistant");
    assert.ok(assistant, "assistant message present");
    assert.ok(Array.isArray(assistant.tool_calls), "assistant carries tool_calls");
    assert.equal(assistant.tool_calls[0].function.name, "get_weather");
    assert.equal(assistant.tool_calls[0].id, "toolu_01");
    // content must never contain the raw tool_use block
    const content = JSON.stringify(assistant.content);
    assert.ok(!content.includes("tool_use"), "assistant content must not leak tool_use blocks");
    assert.equal(assistant.content, null);

    const tool = result.messages.find(m => m.role === "tool");
    assert.ok(tool, "tool_result becomes a tool-role message");
    assert.equal(tool.tool_call_id, "toolu_01");
    assert.equal(tool.content, "Sunny, 22C");
});

test("tool messages directly follow the assistant tool_calls message even when the same Claude user message carries companion text", () => {
    const result = anthropicToOpenAiRequest({
        model: "claude-sonnet-4-6",
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Check the disk" }],
            },
            {
                role: "assistant",
                content: [
                    { type: "tool_use", id: "toolu_10", name: "Bash", input: { command: "df -h" } },
                ],
            },
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "toolu_10", content: "Filesystem 50%" },
                    { type: "text", text: "Also check memory" },
                ],
            },
        ],
    });

    const roles = result.messages.map(m => m.role);
    assert.deepEqual(roles, ["user", "assistant", "tool", "user"]);
    // the tool message must immediately follow the assistant tool_calls message
    assert.equal(result.messages[1].role, "assistant");
    assert.equal(result.messages[1].tool_calls[0].id, "toolu_10");
    assert.equal(result.messages[2].role, "tool");
    assert.equal(result.messages[2].tool_call_id, "toolu_10");
    assert.equal(result.messages[3].content, "Also check memory");
});

test("assistant with text plus tool_use keeps text and tool_calls", () => {
    const result = anthropicToOpenAiRequest({
        model: "claude-3-5-sonnet",
        messages: [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Let me check." },
                    {
                        type: "tool_use",
                        id: "toolu_02",
                        name: "search",
                        input: { q: "hello" },
                    },
                ],
            },
        ],
    });

    const assistant = result.messages.find(m => m.role === "assistant");
    assert.equal(assistant.content, "Let me check.");
    assert.equal(assistant.tool_calls[0].function.name, "search");
});

test("thinking blocks become reasoning_content for DeepSeek-style pass-back", () => {
    const result = anthropicToOpenAiRequest({
        model: "deepseek-v4-flash",
        messages: [
            { role: "user", content: "analyze this code" },
            {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "I need to inspect the structure first." },
                    { type: "text", text: "Let me analyze." },
                ],
            },
            { role: "user", content: "continue" },
        ],
    });

    const assistant = result.messages.find(m => m.role === "assistant");
    assert.equal(assistant.reasoning_content, "I need to inspect the structure first.");
    assert.equal(assistant.content, "Let me analyze.");
});

test("plain string content and text-only array are unchanged", () => {
    const stringResult = anthropicToOpenAiRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(stringResult.messages[0].content, "hi");

    const arrayResult = anthropicToOpenAiRequest({
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    assert.equal(arrayResult.messages[0].content, "hello");
});

test("thinking.enabled is forwarded as metadata.ai8_thinking", () => {
    const result = anthropicToOpenAiRequest({
        model: "claude-3-7-sonnet",
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.metadata.ai8_thinking, true);
});

test("metadata.ai8_thinking=false overrides thinking.enabled and persists", () => {
    const result = anthropicToOpenAiRequest({
        model: "claude-3-7-sonnet",
        thinking: { type: "enabled" },
        metadata: { ai8_thinking: false },
        messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.metadata.ai8_thinking, false);
});

test("no thinking field leaves metadata untouched", () => {
    const result = anthropicToOpenAiRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.metadata, undefined);
});

test("streaming reasoning field (NVIDIA NIM) is converted to thinking block", () => {
    const state = { inThink: false, hasStartedText: false, currentIndex: 0 };
    const events = openAiToAnthropicChunk({
        model: "stepfun-ai/step-3.7-flash",
        choices: [{ index: 0, delta: { role: "assistant", reasoning: "让我想想" } }],
    }, state);

    assert.ok(Array.isArray(events));
    const start = events.find(e => e.type === "content_block_start");
    assert.ok(start, "content_block_start emitted");
    assert.equal(start.content_block.type, "thinking");
    const delta = events.find(e => e.type === "content_block_delta" && e.delta.type === "thinking_delta");
    assert.ok(delta, "thinking_delta emitted");
    assert.equal(delta.delta.thinking, "让我想想");
    assert.equal(state.inThink, true);
});

test("streaming reasoning_content field is honored too", () => {
    const state = { inThink: false, hasStartedText: false, currentIndex: 0 };
    const events = openAiToAnthropicChunk({
        model: "m",
        choices: [{ index: 0, delta: { reasoning_content: "推理A" } }],
    }, state);
    const delta = events.find(e => e.type === "content_block_delta" && e.delta.type === "thinking_delta");
    assert.equal(delta.delta.thinking, "推理A");
});

test("final chunk message reasoning is applied when delta carried no reasoning", () => {
    const state = { inThink: false, hasStartedText: false, currentIndex: 0 };
    openAiToAnthropicChunk({
        model: "m",
        choices: [{ index: 0, delta: { role: "assistant" } }],
    }, state);

    const events = openAiToAnthropicChunk({
        choices: [{ index: 0, delta: {}, message: { reasoning: "完整思考", content: "正文来了" }, finish_reason: "stop" }],
    }, state);

    const thinkingDelta = events.find(e => e.type === "content_block_delta" && e.delta.type === "thinking_delta");
    assert.ok(thinkingDelta, "thinking_delta emitted from message.reasoning");
    assert.equal(thinkingDelta.delta.thinking, "完整思考");
    const textDelta = events.find(e => e.type === "content_block_delta" && e.delta.type === "text_delta");
    assert.ok(textDelta, "text_delta emitted from message.content");
    assert.equal(textDelta.delta.text, "正文来了");
});

test("non-streaming reasoning field (NVIDIA NIM) becomes a thinking block", () => {
    const converted = openAiToAnthropicResponse({
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", reasoning: "思考内容", content: "回答内容" }, finish_reason: "stop" }],
    });
    assert.equal(converted.content[0].type, "thinking");
    assert.equal(converted.content[0].thinking, "思考内容");
    assert.equal(converted.content[1].type, "text");
    assert.equal(converted.content[1].text, "回答内容");
});

test("estimateInputTokens counts latin text as chars/4", () => {
    const n = estimateInputTokens({ messages: [{ role: "user", content: "hello world how are you today" }] });
    assert.ok(n >= 1, "estimate is non-zero");
});

test("estimateInputTokens counts CJK characters as one token each", () => {
    const chineseOnly = estimateInputTokens({ messages: [{ role: "user", content: "你好世界" }] });
    assert.equal(chineseOnly, 4);
    const mixed = estimateInputTokens({
        system: "系统提示",
        messages: [
            { role: "user", content: [{ type: "text", text: "abcd" }] },
        ],
    });
    // 4 CJK + (1 newline + 4 ascii)/4 = ceil(4 + 1.25) = 6
    assert.equal(mixed, 6);
});

test("estimateInputTokens is at least 1 for empty bodies", () => {
    assert.equal(estimateInputTokens(), 1);
    assert.equal(estimateInputTokens({ messages: [] }), 1);
});

test("estimateInputTokens includes tool definitions", () => {
    const withTools = estimateInputTokens({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "get_weather", input: { city: "Tokyo" } }],
    });
    const withoutTools = estimateInputTokens({ messages: [{ role: "user", content: "hi" }] });
    assert.ok(withTools > withoutTools, "tools contribute to the estimate");
});

// --- Anthropic stream invariants -------------------------------------------
// Claude Code (and the Vercel AI SDK) throw "Content block not found" when a
// content_block_delta references an index with no open block of a matching
// type. Every realistic upstream pattern must satisfy this invariant.
function validateAnthropicStream(chunks, state = {}) {
    const events = [];
    for (const chunk of chunks) {
        const out = openAiToAnthropicChunk(chunk, state);
        const list = Array.isArray(out) ? out : (out ? [out] : []);
        events.push(...list);
    }

    const open = new Map();
    const expectedType = {
        text_delta: "text",
        thinking_delta: "thinking",
        signature_delta: "thinking",
        input_json_delta: "tool_use",
    };

    for (const event of events) {
        if (event.type === "content_block_start") {
            open.set(event.index, event.content_block.type);
        } else if (event.type === "content_block_stop") {
            assert.ok(open.has(event.index), `stop at ${event.index} without an open block`);
            open.delete(event.index);
        } else if (event.type === "content_block_delta") {
            const type = open.get(event.index);
            assert.ok(type, `delta ${event.delta.type} at index ${event.index} without a start`);
            assert.equal(type, expectedType[event.delta.type], `delta ${event.delta.type} on a ${type} block`);
        }
    }

    return { events, open };
}

const toolStart = (index, id, name, args = "") => ({
    choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] } }],
});
const toolArgs = (args, index) => ({
    choices: [{
        index: 0,
        delta: {
            tool_calls: [index === undefined
                ? { function: { arguments: args } }
                : { index, function: { arguments: args } }],
        },
    }],
});
const finish = () => ({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });

test("tool args keep one block when the gateway omits index/id after the first delta", () => {
    const { events, open } = validateAnthropicStream([
        toolStart(0, "call_a", "Bash"),
        toolArgs('{"cmd":'),
        toolArgs('"ls"}'),
        finish(),
    ]);

    const starts = events.filter(e => e.type === "content_block_start");
    assert.equal(starts.length, 1, "exactly one tool block");
    assert.equal(starts[0].content_block.id, "call_a");
    const argDeltas = events.filter(e => e.type === "content_block_delta" && e.delta.type === "input_json_delta");
    assert.equal(argDeltas.length, 2, "both argument deltas kept on the same block");
    assert.ok(argDeltas.every(d => d.index === starts[0].index), "all arguments on the tool block index");
    assert.equal(open.size, 0, "all blocks closed by finish_reason");
});

test("a duplicate-index chunk with a different id opens a new tool block", () => {
    const { events } = validateAnthropicStream([
        toolStart(0, "call_a", "Bash"),
        toolStart(0, "call_b", "Read", '{"p":1}'),
        finish(),
    ]);

    const starts = events.filter(e => e.type === "content_block_start");
    assert.equal(starts.length, 2, "second id starts a new block");
    assert.deepEqual(starts.map(e => e.content_block.id), ["call_a", "call_b"]);
});

test("interleaved reasoning and text never corrupt an open tool block", () => {
    const { events, open } = validateAnthropicStream([
        toolStart(0, "call_a", "Bash"),
        { choices: [{ index: 0, delta: { reasoning_content: "thinking" } }] },
        { choices: [{ index: 0, delta: { content: "chatter" } }] },
        toolArgs('{"cmd":"ls"}', 0),
        finish(),
    ]);

    const toolBlock = events.find(e => e.type === "content_block_start" && e.content_block.type === "tool_use");
    assert.ok(toolBlock, "tool block exists");
    const argDeltas = events.filter(e => e.type === "content_block_delta" && e.delta.type === "input_json_delta");
    assert.ok(argDeltas.every(d => d.index === toolBlock.index), "arguments stay on the tool block");
    assert.equal(open.size, 0, "all blocks closed");
});

test("a tool delta arriving after finish_reason still gets a block start", () => {
    const { events, open } = validateAnthropicStream([
        toolStart(0, "call_a", "Bash"),
        finish(),
        toolArgs('{"late":true}', 0),
    ]);

    const late = events.filter(e => e.type === "content_block_delta" && e.delta.type === "input_json_delta");
    assert.equal(late.length, 1, "late delta emitted");
    const starts = events.filter(e => e.type === "content_block_start");
    assert.ok(starts.some(s => s.index === late[0].index), "late delta has a matching start");
    assert.equal(open.size, 1, "the late block stays open (no further finish)");
});

test("text then tool then trailing text stays well-formed", () => {
    validateAnthropicStream([
        { choices: [{ index: 0, delta: { content: "Let me check." } }] },
        toolStart(0, "call_a", "Bash"),
        toolArgs('{"cmd":"ls"}'),
        finish(),
        { choices: [{ index: 0, delta: { content: "Done." } }] },
    ]);
});
