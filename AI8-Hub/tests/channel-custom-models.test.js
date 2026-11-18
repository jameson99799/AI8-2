"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RuntimeConfigStore = require("../lib/runtime-config");
const {
    clearResolutionCache,
    filterCachedModels,
    invalidateModelPool,
    isChannelCustomModel,
    resolveTargetChannel,
    withCustomModels,
} = require("../lib/channel-manager");

function baseConfig(overrides = {}) {
    return {
        ai8Enabled: true,
        ai8BlacklistedModels: [],
        ai8AllowedModels: [],
        blacklistedModels: [],
        gptallEnabled: false,
        gptallBlacklistedModels: [],
        freegptEnabled: false,
        freegptBlacklistedModels: [],
        lsshirtaiEnabled: false,
        lsshirtaiBlacklistedModels: [],
        customChannels: [],
        ai8CustomModels: [],
        gptallCustomModels: [],
        freegptCustomModels: [],
        lsshirtaiCustomModels: [],
        ...overrides,
    };
}

test("withCustomModels appends manual models with channel suffixes and markers", () => {
    const config = baseConfig({
        ai8CustomModels: ["my-ai8-model"],
        gptallCustomModels: ["my-gptall-model"],
        freegptCustomModels: ["my-freegpt-model"],
        lsshirtaiCustomModels: ["google::my-lss-model"],
        customChannels: [
            { name: "nvidia", enabled: true, customModels: ["my-nvidia-model"] },
        ],
    });

    const merged = withCustomModels([], config);
    const bySource = Object.fromEntries(merged.map(m => [m._source, m]));

    assert.equal(bySource.ai8.value, "my-ai8-model【AI8直连】");
    assert.equal(bySource.ai8.origId, "my-ai8-model");
    assert.equal(bySource.ai8.attr.custom, true);
    assert.equal(bySource.gptall.value, "my-gptall-model【gpt-all】");
    assert.equal(bySource.gptall.channel, "gpt-all");
    assert.equal(bySource.freegpt.value, "my-freegpt-model【freegpt】");
    assert.equal(bySource.lsshirtai.value, "google::my-lss-model【lsshirtai】");
    assert.equal(bySource.lsshirtai._isToolSupported, false);
    assert.equal(bySource.nvidia.value, "my-nvidia-model【nvidia】");
    assert.equal(bySource.nvidia._actualModel, "my-nvidia-model");
    for (const model of merged) {
        assert.equal(model._custom, true);
    }
});

test("withCustomModels skips models already present in the upstream catalog", () => {
    const config = baseConfig({
        ai8CustomModels: ["openai_chat::gpt-4.1-mini"],
    });
    const upstream = [
        {
            label: "openai_chat::gpt-4.1-mini【AI8直连】",
            value: "openai_chat::gpt-4.1-mini【AI8直连】",
            origId: "openai_chat::gpt-4.1-mini",
            attr: { providerName: "ai8" },
            _source: "ai8",
        },
    ];

    const merged = withCustomModels(upstream, config);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]._custom, undefined);
});

test("filterCachedModels lets manual models bypass the whitelist but keeps blacklists", () => {
    const config = baseConfig({
        lsshirtaiEnabled: true,
        lsshirtaiCustomModels: ["google::my-lss-model"],
        lsshirtaiBlacklistedModels: ["gemini-3.7-flash"],
        ai8CustomModels: ["my-ai8-model"],
        ai8BlacklistedModels: ["blocked-ai8"],
        customChannels: [
            {
                name: "nvidia",
                enabled: true,
                models: ["upstream-only"],
                blacklistedModels: ["blocked-nvidia"],
                customModels: ["my-nvidia-model", "blocked-nvidia"],
            },
        ],
    });

    const models = withCustomModels(
        [
            {
                label: "upstream-only【nvidia】",
                value: "upstream-only【nvidia】",
                origId: "upstream-only",
                channel: "nvidia",
                attr: { providerName: "nvidia" },
                _source: "nvidia",
            },
        ],
        config
    );

    // nvidia whitelist would normally hide the manual model; manual models bypass it.
    const visible = filterCachedModels(models, config, false).map(m => m.origId);
    assert.ok(visible.includes("my-ai8-model"));
    assert.ok(!visible.includes("blocked-ai8"));
    assert.ok(visible.includes("google::my-lss-model"));
    assert.ok(visible.includes("my-nvidia-model"));
    assert.ok(!visible.includes("blocked-nvidia"));
    assert.ok(visible.includes("upstream-only"));
});

test("filterCachedModels hides manual models of disabled channels", () => {
    const config = baseConfig({
        ai8Enabled: false,
        gptallEnabled: false,
        ai8CustomModels: ["my-ai8-model"],
        gptallCustomModels: ["my-gptall-model"],
        customChannels: [
            { name: "nvidia", enabled: false, customModels: ["my-nvidia-model"] },
        ],
    });

    const models = withCustomModels([], config);
    const visible = filterCachedModels(models, config, false).map(m => m.origId);
    assert.ok(!visible.includes("my-ai8-model"));
    assert.ok(!visible.includes("my-gptall-model"));
    assert.ok(!visible.includes("my-nvidia-model"));
});

test("bare manual model names route straight from config without the model cache", async () => {
    clearResolutionCache();
    invalidateModelPool();
    const config = baseConfig({
        gptallEnabled: true,
        gptallAuthToken: "tok",
        gptallCustomModels: ["fresh-gptall-model"],
        freegptEnabled: true,
        freegptUuid: "uuid",
        freegptCustomModels: ["fresh-freegpt-model"],
        lsshirtaiEnabled: true,
        lsshirtaiAuthToken: "jwt",
        lsshirtaiCustomModels: ["fresh-lss-model"],
        customChannels: [
            { name: "nvidia", enabled: true, baseUrl: "https://x/v1", apiKey: "k", customModels: ["fresh-nvidia-model"] },
        ],
    });

    const gptall = await resolveTargetChannel("fresh-gptall-model", config, null);
    assert.equal(gptall.targetChannel.protocol, "gptall");
    assert.equal(gptall.actualModel, "fresh-gptall-model");

    const freegpt = await resolveTargetChannel("fresh-freegpt-model", config, null);
    assert.equal(freegpt.targetChannel.protocol, "freegpt");

    const lss = await resolveTargetChannel("fresh-lss-model", config, null);
    assert.equal(lss.targetChannel.protocol, "lsshirtai");
    assert.equal(lss.toolSupported, false);

    const nvidia = await resolveTargetChannel("fresh-nvidia-model", config, null);
    assert.equal(nvidia.targetChannel.name, "nvidia");
    assert.equal(nvidia.actualModel, "fresh-nvidia-model");

    // AI8 manual models fall through to the default AI8 path; the chat
    // handler recognizes them through isChannelCustomModel.
    const ai8 = await resolveTargetChannel("fresh-ai8-model", baseConfig({ ai8CustomModels: ["fresh-ai8-model"] }), null);
    assert.equal(ai8.targetChannel, null);
    assert.equal(ai8.actualModel, "fresh-ai8-model");

    // Disabled channels must not capture their manual models. The cache must
    // be cleared first: "fresh-lss-model" was just resolved against the
    // enabled config above, and resolutionCache has a 5-minute TTL.
    clearResolutionCache();
    const disabled = await resolveTargetChannel(
        "fresh-lss-model",
        baseConfig({ lsshirtaiCustomModels: ["fresh-lss-model"] }),
        null
    );
    assert.equal(disabled.targetChannel, null);
});

test("isChannelCustomModel matches provider-qualified ids for lsshirtai", () => {
    const config = baseConfig({ lsshirtaiCustomModels: ["google::my-lss-model"] });
    assert.equal(isChannelCustomModel(config, "lsshirtai", "google::my-lss-model"), true);
    assert.equal(isChannelCustomModel(config, "lsshirtai", "my-lss-model"), true);
    assert.equal(isChannelCustomModel(config, "lsshirtai", "other-model"), false);
    assert.equal(isChannelCustomModel(config, "ai8", "my-lss-model"), false);
});

test("manual model CSV fields round-trip through the editable config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai8-custom-cfg-"));
    const storePath = path.join(dir, "config.json");
    try {
        const store = new RuntimeConfigStore({ storePath, defaults: { adminToken: "test-token" } });
        store.updateConfig({
            ai8CustomModels: "my-a, my-b",
            gptallCustomModels: "my-g",
            freegptCustomModels: "my-f",
            lsshirtaiCustomModels: "google::my-l",
        });

        const editable = store.getEditableConfig();
        assert.equal(editable.ai8CustomModels, "my-a,my-b");
        assert.equal(editable.gptallCustomModels, "my-g");
        assert.equal(editable.freegptCustomModels, "my-f");
        assert.equal(editable.lsshirtaiCustomModels, "google::my-l");

        const reloaded = new RuntimeConfigStore({ storePath, defaults: { adminToken: "test-token" } });
        assert.deepEqual(reloaded.getConfig().ai8CustomModels, ["my-a", "my-b"]);
        assert.deepEqual(reloaded.getConfig().lsshirtaiCustomModels, ["google::my-l"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
