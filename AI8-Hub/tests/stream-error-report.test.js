"use strict";

// E2E: upstream failures during a streaming chat must reach the client as an
// SSE error frame carrying the real upstream message, instead of a truncated
// stream (clients then only report "stream ended without a finish reason").

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HUB_DIR = path.join(__dirname, "..");

const DEPLETED_MESSAGE =
    "Your prepayment credits are depleted. Please go to AI Studio at " +
    "https://ai.studio/projects to manage your project and billing.";

const upstreamState = {
    sessionStatus: 200,
    sessionPayload: { code: 0, data: { id: 4242, model: "openai_chat::stream-test-model", uid: 1 } },
    completionsFrames: [],
};

function sse(payload) {
    return `data: ${JSON.stringify(payload)}\n\n`;
}

const mockUpstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const sendJson = payload => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
    };

    if (url.pathname === "/api/chat/tmpl") {
        return sendJson({
            code: 0,
            data: {
                models: [
                    {
                        value: "openai_chat::stream-test-model",
                        label: "Stream Test",
                        attr: {
                            capabilities: { stream: true, tools: true, systemRole: true },
                            providerName: "Oy-ai",
                        },
                    },
                ],
            },
        });
    }

    if (url.pathname === "/api/chat/session") {
        res.writeHead(upstreamState.sessionStatus, { "content-type": "application/json" });
        return res.end(JSON.stringify(upstreamState.sessionPayload));
    }

    if (url.pathname === "/api/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const frame of upstreamState.completionsFrames) {
            res.write(sse(frame));
        }
        return res.end();
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 404 }));
});

function waitForHub(url, deadlineMs = 20000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + deadlineMs;
        const tick = async () => {
            try {
                const response = await fetch(url);
                if (response.ok) return resolve();
            } catch {}
            if (Date.now() > deadline) return reject(new Error("hub did not start"));
            setTimeout(tick, 250);
        };
        tick();
    });
}

function parseSseDataFrames(body) {
    return body
        .split("\n\n")
        .map(block => block.split("\n").find(line => line.startsWith("data: ")))
        .filter(Boolean)
        .map(line => line.slice("data: ".length))
        .filter(raw => raw !== "[DONE]")
        .map(raw => {
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

test("upstream failures during a stream surface the real message and a clean end", { concurrency: false }, async (t) => {
    const mockPort = await new Promise(resolve => {
        mockUpstream.listen(0, "127.0.0.1", () => resolve(mockUpstream.address().port));
    });
    t.after(() => new Promise(resolve => mockUpstream.close(resolve)));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai8-stream-error-"));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    const hubPort = 18791;
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(
        configPath,
        JSON.stringify({
            adminToken: "test-admin",
            ai8AuthToken: "test-token",
            ai8BaseUrl: `http://127.0.0.1:${mockPort}/api`,
            ai8DefaultModel: "openai_chat::stream-test-model",
            apiKeys: "",
            customChannels: [],
            gptallEnabled: false,
            freegptEnabled: false,
            lsshirtaiEnabled: false,
        })
    );

    const hub = spawn(process.execPath, ["server.js"], {
        cwd: HUB_DIR,
        env: {
            ...process.env,
            AI8_CONFIG_PATH: configPath,
            AI8_LOG_PATH: path.join(tempDir, "hub.log"),
            AI8_AUTH_TOKEN: "test-token",
            PORT: String(hubPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => hub.kill());
    await waitForHub(`http://127.0.0.1:${hubPort}/health`);

    const post = body =>
        fetch(`http://127.0.0.1:${hubPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    await t.test("error in the middle of the stream", async () => {
        upstreamState.sessionStatus = 200;
        upstreamState.sessionPayload = { code: 0, data: { id: 4242, model: "openai_chat::stream-test-model", uid: 1 } };
        upstreamState.completionsFrames = [
            { code: 0, id: "task-1", data: "Hello " },
            { code: 3007, err: DEPLETED_MESSAGE },
        ];

        const response = await post({
            model: "openai_chat::stream-test-model【AI8直连】",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(response.status, 200);
        assert.ok(String(response.headers.get("content-type")).includes("text/event-stream"));

        const body = await response.text();
        const frames = parseSseDataFrames(body);

        // Partial content delivered before the failure is preserved.
        assert.ok(frames.some(frame => frame.choices?.[0]?.delta?.content === "Hello "));

        // The real upstream message is relayed verbatim in an error frame.
        const errorFrame = frames.find(frame => frame.error);
        assert.ok(errorFrame, `expected an error frame in: ${body}`);
        assert.equal(errorFrame.error.message, `上游异常：${DEPLETED_MESSAGE}`);
        // Error-only frame: consumers that validate against the OpenAI chunk
        // schema must not drop the message while validating `choices`.
        assert.ok(!("choices" in errorFrame));

        assert.ok(body.trimEnd().endsWith("data: [DONE]"));
    });

    await t.test("session creation failure", async () => {
        upstreamState.sessionStatus = 200;
        upstreamState.sessionPayload = { code: 1001, err: "授权登陆已过期，请重新登陆" };
        upstreamState.completionsFrames = [];

        const response = await post({
            model: "openai_chat::stream-test-model【AI8直连】",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(response.status, 200);

        const body = await response.text();
        const frames = parseSseDataFrames(body);
        const errorFrame = frames.find(frame => frame.error);
        assert.ok(errorFrame, `expected an error frame in: ${body}`);
        assert.equal(errorFrame.error.message, "上游异常：授权登陆已过期，请重新登陆");
        assert.ok(body.trimEnd().endsWith("data: [DONE]"));
    });
});
