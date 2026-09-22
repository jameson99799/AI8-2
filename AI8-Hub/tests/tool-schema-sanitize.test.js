"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeToolSchemas } = require("../lib/channel-manager");

test("sanitizeToolSchemas strips keywords Gemini rejects while keeping the shape", () => {
    const tools = [
        {
            type: "function",
            function: {
                name: "Skill",
                description: "run a skill",
                parameters: {
                    type: "object",
                    $schema: "http://json-schema.org/draft-07/schema#",
                    propertyNames: { pattern: "^[a-z]+$" },
                    patternProperties: { "^x": { type: "string" } },
                    properties: {
                        name: { type: "string", description: "skill name", minLength: 1, pattern: "^\\w+$" },
                        args: {
                            type: "object",
                            propertyNames: { type: "string" },
                            additionalProperties: { type: "string" },
                        },
                    },
                    required: ["name"],
                    additionalProperties: false,
                    oneOf: [{ required: ["name"] }],
                },
            },
        },
    ];

    const [sanitized] = sanitizeToolSchemas(tools);
    const params = sanitized.function.parameters;

    assert.equal(params.type, "object");
    assert.deepEqual(params.required, ["name"]);
    assert.ok(params.properties.name, "plain properties survive");
    assert.equal(params.properties.name.type, "string");
    assert.equal(params.properties.name.description, "skill name");
    assert.ok(params.properties.args, "nested object survives");
    assert.equal(params.properties.args.type, "object");
    assert.deepEqual(params.properties.args.additionalProperties, { type: "string" });

    // keywords Gemini does not understand are gone
    assert.equal(params.propertyNames, undefined);
    assert.equal(params.patternProperties, undefined);
    assert.equal(params.$schema, undefined);
    assert.equal(params.oneOf, undefined);
    assert.equal(params.properties.name.minLength, undefined);
    assert.equal(params.properties.name.pattern, undefined);
    assert.equal(params.properties.args.propertyNames, undefined);
});

test("sanitizeToolSchemas keeps tools without parameters untouched", () => {
    const tools = [{ type: "function", function: { name: "Ping" } }];
    const sanitized = sanitizeToolSchemas(tools);
    assert.deepEqual(sanitized, tools);
});

test("sanitizeToolSchemas preserves enum, anyOf and nested items", () => {
    const tools = [
        {
            function: {
                name: "Pick",
                parameters: {
                    type: "object",
                    properties: {
                        mode: { type: "string", enum: ["a", "b"] },
                        value: { anyOf: [{ type: "string" }, { type: "number" }] },
                        list: { type: "array", items: { type: "string", const: "x" } },
                    },
                },
            },
        },
    ];

    const [sanitized] = sanitizeToolSchemas(tools);
    const props = sanitized.function.parameters.properties;
    assert.deepEqual(props.mode.enum, ["a", "b"]);
    assert.equal(props.value.anyOf.length, 2);
    assert.equal(props.list.items.type, "string");
    assert.equal(props.list.items.const, undefined);
});
