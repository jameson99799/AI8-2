"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RuntimeConfigStore = require("../lib/runtime-config");
const { buildAdminModelsList, buildModelsList } = require("../lib/openai-format");
const {
    buildLssClient,
    clearResolutionCache,
    filterCachedModels,
    isBlacklisted,
    isLssChatModel,
    resolveTargetChannel,
    toLssAggregatedModel,
} = require("../lib/channel-manager");

function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai8-lss-cfg-"));
    const storePath = path.join(dir, "config.json");
    const store = new RuntimeConfigStore({ storePath, defaults: { adminToken: "test-token" } });
    return { store, storePath, dir };
}

function baseConfig(overrides = {}) {
    return {
        ai8Enabled: true,
        ai8BlacklistedModels: [],
        ai8AllowedModels: [],
        blacklistedModels: [],
        customChannels: [],
        gptallEnabled: false,
        gptallBlacklistedModels: [],
        freegptEnabled: false,
        freegptBlacklistedModels: [],
        lsshirtaiEnabled: true,
        lsshirtaiAllowedModels: [],
        lsshirtaiBlacklistedModels: [],
        ...overrides,
    };
}

test("lsshirtai config is disabled by default with the expected endpoint defaults", () => {
    const { store, dir } = makeStore();
    try {
        const config = store.getConfig();
        assert.equal(config.lsshirtaiEnabled, false);
        assert.equal(config.lsshirtaiBaseUrl, "https://www.lsshirtai.com/api");
        assert.equal(config.lsshirtaiXAppVersion, "3.4.2");
        assert.equal(config.lsshirtaiDefaultModel, "google::gemini-3.7-flash");
        assert.deepEqual(config.lsshirtaiAllowedModels, []);
        assert.deepEqual(config.lsshirtaiBlacklistedModels, []);
        assert.equal(config.lsshirtaiDeleteSessionAfterResponse, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("lsshirtai config round-trips through getEditableConfig and disk", () => {
    const { store, storePath, dir } = makeStore();
    try {
        store.updateConfig({
            lsshirtaiEnabled: true,
            lsshirtaiAuthToken: "jwt-token",
            lsshirtaiAllowedModels: "google::gemini-3.7-flash, anthropic::claude-opus-4-6",
            lsshirtaiBlacklistedModels: "openai::gpt-4o",
            lsshirtaiDeleteSessionAfterResponse: false,
        });

        const editable = store.getEditableConfig();
        assert.equal(editable.lsshirtaiEnabled, true);
        assert.equal(editable.lsshirtaiAuthToken, "jwt-token");
        assert.equal(editable.lsshirtaiAllowedModels, "google::gemini-3.7-flash,anthropic::claude-opus-4-6");
        assert.equal(editable.lsshirtaiBlacklistedModels, "openai::gpt-4o");
        assert.equal(editable.lsshirtaiDeleteSessionAfterResponse, false);

        const reloaded = new RuntimeConfigStore({ storePath, defaults: { adminToken: "test-token" } });
        assert.deepEqual(reloaded.getConfig().lsshirtaiAllowedModels, [
            "google::gemini-3.7-flash",
            "anthropic::claude-opus-4-6",
        ]);
        assert.equal(reloaded.getConfig().lsshirtaiEnabled, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("buildLssClient carries the independent lsshirtai settings", () => {
    const client = buildLssClient({
        lsshirtaiAuthToken: "jwt-token",
        lsshirtaiBaseUrl: "https://www.lsshirtai.com/api/",
        lsshirtaiDefaultModel: "google::gemini-3.7-flash",
        lsshirtaiRequestTimeoutMs: 123456,
        lsshirtaiXAppVersion: "3.4.2",
    });

    assert.equal(client.authToken, "jwt-token");
    assert.equal(client.baseUrl, "https://www.lsshirtai.com/api");
    assert.equal(client.defaultModel, "google::gemini-3.7-flash");
    assert.equal(client.requestTimeoutMs, 123456);
    assert.equal(client.xAppVersion, "3.4.2");
});

test("toLssAggregatedModel adds the lsshirtai suffix and disables tools", () => {
    const model = toLssAggregatedModel({ value: "google::gemini-3.7-flash" });

    assert.equal(model.value, "google::gemini-3.7-flash【lsshirtai】");
    assert.equal(model.origId, "google::gemini-3.7-flash");
    assert.equal(model.channel, "lsshirtai");
    assert.equal(model._source, "lsshirtai");
    assert.equal(model._actualModel, "google::gemini-3.7-flash");
    assert.equal(model._isToolSupported, false);
    assert.equal(model.attr.capabilities.tools, false);
});

test("lsshirtai catalog filter keeps chat models and drops image/video/audio entries", () => {
    const kept = [
        "google::gemini-3.7-flash",
        "google::gemini-3.1-pro",
        "anthropic::claude-opus-4-6",
        "openai::gpt-5.4",
        "deepseek::deepseek-v4-pro",
        "qwen::qwen3.5-max",
        "xai::grok-4.1",
    ];
    const dropped = [
        "openai::gpt-image-2",
        "openai::dall-e-3",
        "google::gemini-3-pro-image-preview",
        "google::nano-banana-2",
        "google::veo-3",
        "openai::gpt-realtime",
        "openai::gpt-4o-audio-preview",
        "openai::text-embedding-3-large",
        "qwen::qwen-image-2.0-pro",
        "kling::kling-omni-image",
        "minimax::image-01",
    ];

    for (const value of kept) {
        assert.equal(isLssChatModel({ value }), true, `${value} should stay in the chat list`);
    }
    for (const value of dropped) {
        assert.equal(isLssChatModel({ value }), false, `${value} should be filtered out`);
    }
});

test("filterCachedModels hides lsshirtai when disabled and applies its own lists", () => {
    const models = [
        toLssAggregatedModel({ value: "google::gemini-3.7-flash" }),
        toLssAggregatedModel({ value: "anthropic::claude-opus-4-6" }),
        { origId: "openai_chat::gpt-4.1-mini", value: "openai_chat::gpt-4.1-mini【AI8直连】", _source: "ai8" },
    ];

    const enabled = filterCachedModels(models, baseConfig(), false);
    assert.ok(enabled.some(m => m.origId === "google::gemini-3.7-flash"));
    assert.ok(enabled.some(m => m.origId === "anthropic::claude-opus-4-6"));

    const disabled = filterCachedModels(models, baseConfig({ lsshirtaiEnabled: false }), false);
    assert.ok(!disabled.some(m => m._source === "lsshirtai"));
    assert.ok(disabled.some(m => m._source === "ai8"));

    const blacklisted = filterCachedModels(
        models,
        baseConfig({ lsshirtaiBlacklistedModels: ["gemini-3.7-flash"] }),
        false
    );
    assert.ok(!blacklisted.some(m => m.origId === "google::gemini-3.7-flash"));
    assert.ok(blacklisted.some(m => m.origId === "anthropic::claude-opus-4-6"));

    const whitelisted = filterCachedModels(
        models,
        baseConfig({ lsshirtaiAllowedModels: ["anthropic::claude-opus-4-6"] }),
        false
    );
    assert.ok(!whitelisted.some(m => m.origId === "google::gemini-3.7-flash"));
    assert.ok(whitelisted.some(m => m.origId === "anthropic::claude-opus-4-6"));
});

test("lsshirtai blacklist matches both provider-qualified and short model ids", () => {
    const channel = { name: "lsshirtai", protocol: "lsshirtai" };

    const full = { ai8BlacklistedModels: [], lsshirtaiBlacklistedModels: ["google::gemini-3.7-flash"] };
    assert.equal(isBlacklisted("google::gemini-3.7-flash", full, channel), true);
    assert.equal(isBlacklisted("gemini-3.7-flash", full, channel), true);
    assert.equal(isBlacklisted("anthropic::claude-opus-4-6", full, channel), false);

    const short = { ai8BlacklistedModels: [], lsshirtaiBlacklistedModels: ["gemini-3.7-flash"] };
    assert.equal(isBlacklisted("google::gemini-3.7-flash", short, channel), true);
});

test("model listings keep lsshirtai provider prefixes without changing other channels", () => {
    const lssModel = toLssAggregatedModel({ value: "google::gemini-3.7-flash" });
    const ai8Model = {
        label: "openai_chat::gpt-4.1-mini【AI8直连】",
        value: "openai_chat::gpt-4.1-mini【AI8直连】",
        origId: "openai_chat::gpt-4.1-mini",
        attr: { providerName: "ai8" },
        _source: "ai8",
    };

    const list = buildModelsList([lssModel, ai8Model]);
    assert.equal(list.data[0].id, "google::gemini-3.7-flash【lsshirtai】");
    assert.equal(list.data[0].name, "google::gemini-3.7-flash【lsshirtai】");
    assert.equal(list.data[1].id, "gpt-4.1-mini【AI8直连】");
    assert.equal(list.data[1].name, "gpt-4.1-mini【AI8直连】");

    const admin = buildAdminModelsList([lssModel, ai8Model]);
    assert.equal(admin[0].display_value, "google::gemini-3.7-flash【lsshirtai】");
    assert.equal(admin[1].display_value, "gpt-4.1-mini【AI8直连】");
});

test("resolveTargetChannel routes the lsshirtai suffix without touching custom channels", async () => {
    clearResolutionCache();
    const config = baseConfig();

    const resolved = await resolveTargetChannel("google::gemini-3.7-flash【lsshirtai】", config, null);
    assert.equal(resolved.targetChannel.protocol, "lsshirtai");
    assert.equal(resolved.targetChannel.name, "lsshirtai");
    assert.equal(resolved.actualModel, "google::gemini-3.7-flash");
    assert.equal(resolved.toolSupported, false);

    const alias = await resolveTargetChannel("gemini-3.7-flash【lss】", config, null);
    assert.equal(alias.targetChannel.protocol, "lsshirtai");
    assert.equal(alias.actualModel, "gemini-3.7-flash");
});
