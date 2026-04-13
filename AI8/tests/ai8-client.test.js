"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const AI8Client = require("../lib/ai8-client");

function createClient() {
    return new AI8Client({
        authToken: "test-token",
        baseUrl: "https://example.com/api",
    });
}

test("AI8 auth-expired business errors are normalized to 401 even when upstream HTTP status is 200", () => {
    const client = createClient();

    const error = client._normalizeError(
        {
            code: 1001,
            msg: "授权登陆已过期，请重新登陆",
        },
        200
    );

    assert.equal(error.status, 401);
    assert.equal(error.code, 1001);
    assert.equal(error.message, "授权登陆已过期，请重新登陆");
});

test("generic AI8 business errors on HTTP 200 are normalized to 502 and keep upstream payload", () => {
    const client = createClient();

    const error = client._normalizeError(
        {
            code: 3007,
            data: {
                reason: "upstream failed",
            },
            msg: "生成失败",
        },
        200
    );

    assert.equal(error.status, 502);
    assert.equal(error.code, 3007);
    assert.deepEqual(error.upstream, {
        code: 3007,
        data: {
            reason: "upstream failed",
        },
        msg: "生成失败",
    });
});
