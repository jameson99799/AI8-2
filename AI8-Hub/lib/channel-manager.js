"use strict";

const GptAllClient = require("./gptall-client");
const FreeGptClient = require("./freegpt-client");
const AI8Client = require("./ai8-client");
const { AI8_DRAW_MODELS } = AI8Client;

const LSS_CHANNEL_NAME = "lsshirtai";
const LSS_MODEL_SUFFIX = `【${LSS_CHANNEL_NAME}】`;

// lsshirtai's catalog is a chat-model list, but it also exposes image,
// video, realtime, audio and embedding entries. Those cannot be driven
// through the text chat endpoint, so keep them out of the aggregate pool.
const LSS_EXCLUDED_MODEL_PATTERN =
    /(?:^|[-_.:/])(dall-?e|gpt-image|image|imagen|imagine|nano-banana|flux|midjourney|niji|mj|sora|veo|runway|pika|kling|seedream|seedance|recraft|ideogram|stable-diffusion|sdxl|cogview|kolors|wan\d|qwen-image|hunyuan-image|realtime|live|audio|tts|whisper|transcribe|speech|embedding|embed|moderation|rerank)(?:$|[-_.:/])/i;

function isLssChatModel(model) {
    const raw = String(model?.value || model?.model || model?.id || "").trim();
    if (!raw) {
        return false;
    }

    const name = raw.includes("::") ? raw.split("::").pop() : raw;
    const type = String(model?.type || model?.attr?.type || "").toLowerCase();
    if (["image", "image_generation", "video", "audio", "realtime", "embedding"].includes(type)) {
        return false;
    }

    return !LSS_EXCLUDED_MODEL_PATTERN.test(name);
}

function lssModelIdMatches(list, modelId) {
    const id = String(modelId || "").trim();
    if (!id) {
        return false;
    }

    const shortId = id.includes("::") ? id.split("::").pop() : id;
    return (Array.isArray(list) ? list : []).some(item => {
        const value = String(item || "").trim();
        if (!value) {
            return false;
        }
        const shortValue = value.includes("::") ? value.split("::").pop() : value;
        return value === id || value === shortId || shortValue === shortId;
    });
}

function toLssAggregatedModel(model) {
    const origId = String(model?.value || model?.model || model?.id || "").trim();
    if (!origId) {
        return null;
    }

    const value = `${origId}${LSS_MODEL_SUFFIX}`;
    return {
        label: value,
        value,
        origId,
        channel: LSS_CHANNEL_NAME,
        attr: { providerName: LSS_CHANNEL_NAME, capabilities: { tools: false } },
        _source: LSS_CHANNEL_NAME,
        _actualModel: origId,
        _isToolSupported: false,
    };
}

function buildLssClient(config) {
    if (!config || !config.lsshirtaiAuthToken) {
        throw new Error("LSSHIRTAI_AUTH_TOKEN is not configured.");
    }
    return new AI8Client({
        authToken: config.lsshirtaiAuthToken,
        baseUrl: config.lsshirtaiBaseUrl,
        defaultModel: config.lsshirtaiDefaultModel,
        requestTimeoutMs: config.lsshirtaiRequestTimeoutMs,
        xAppVersion: config.lsshirtaiXAppVersion,
    });
}

function buildGptAllClient(config) {
    if (!config || !config.gptallAuthToken) {
        throw new Error("GPTALL_AUTH_TOKEN is not configured.");
    }
    return new GptAllClient({
        authToken: config.gptallAuthToken,
        baseUrl: config.gptallBaseUrl,
        cookie: config.gptallCookie,
        fingerprint: config.gptallFingerprint,
        defaultModel: config.gptallDefaultModel,
        deleteGroupAfterResponse: config.gptallDeleteGroupAfterResponse,
        requestTimeoutMs: config.gptallRequestTimeoutMs,
    });
}

function buildFreeGptClient(config) {
    if (!config || !config.freegptUuid) {
        throw new Error("FREEGPT_UUID is not configured.");
    }
    return new FreeGptClient({
        baseUrl: config.freegptBaseUrl,
        uuid: config.freegptUuid,
        clientIp: config.freegptClientIp,
        defaultModel: config.freegptDefaultModel,
        requestTimeoutMs: config.freegptRequestTimeoutMs,
    });
}

// Model aggregation used to build a fresh gpt-all/freegpt/lss client for
// every aggregation, discarding each client's internal 5-minute model caches
// and re-hitting their upstreams on every pool refresh. Instances are kept
// per config signature instead.
const modelClientCache = new Map();

function cachedChannelModelClient(key, signature, factory) {
    const cached = modelClientCache.get(key);
    if (cached && cached.signature === signature) {
        return cached.instance;
    }
    const instance = factory();
    modelClientCache.set(key, { signature, instance });
    return instance;
}

function getGptAllModelClient(config) {
    const signature = [
        config.gptallAuthToken,
        config.gptallBaseUrl,
        config.gptallCookie,
        config.gptallFingerprint,
        config.gptallRequestTimeoutMs,
    ].join("|");
    return cachedChannelModelClient("gptall", signature, () => buildGptAllClient(config));
}

function getFreeGptModelClient(config) {
    const signature = [
        config.freegptUuid,
        config.freegptBaseUrl,
        config.freegptClientIp,
        config.freegptRequestTimeoutMs,
    ].join("|");
    return cachedChannelModelClient("freegpt", signature, () => buildFreeGptClient(config));
}

function getLssModelClient(config) {
    const signature = [
        config.lsshirtaiAuthToken,
        config.lsshirtaiBaseUrl,
        config.lsshirtaiXAppVersion,
        config.lsshirtaiRequestTimeoutMs,
    ].join("|");
    return cachedChannelModelClient("lsshirtai", signature, () => buildLssClient(config));
}

// Manually added model names ("custom models") are kept per channel so the
// admin can expose upstream models that the catalog fetch misses. They are
// merged into the aggregated pool on every read and bypass the channel
// whitelist (they are explicitly added), but still honor blacklists.
const CUSTOM_MODEL_SUFFIX = {
    ai8: "【AI8直连】",
    gptall: "【gpt-all】",
    freegpt: "【freegpt】",
    [LSS_CHANNEL_NAME]: LSS_MODEL_SUFFIX,
};

function customModelConfigList(config, source) {
    if (source === "ai8") {
        return Array.isArray(config.ai8CustomModels) ? config.ai8CustomModels : [];
    }
    if (source === "gptall") {
        return Array.isArray(config.gptallCustomModels) ? config.gptallCustomModels : [];
    }
    if (source === "freegpt") {
        return Array.isArray(config.freegptCustomModels) ? config.freegptCustomModels : [];
    }
    if (source === LSS_CHANNEL_NAME) {
        return Array.isArray(config.lsshirtaiCustomModels) ? config.lsshirtaiCustomModels : [];
    }
    const channel = (config.customChannels || []).find(c => c.name === source);
    return Array.isArray(channel?.customModels) ? channel.customModels : [];
}

function isChannelCustomModel(config, source, modelId) {
    const name = String(modelId || "").trim();
    if (!name) {
        return false;
    }

    const list = customModelConfigList(config, source);
    if (source === LSS_CHANNEL_NAME) {
        return lssModelIdMatches(list, name);
    }
    return list.includes(name);
}

function buildCustomModelEntry(config, source, name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) {
        return null;
    }

    const suffix = CUSTOM_MODEL_SUFFIX[source] || `【${source}】`;
    const value = `${trimmed}${suffix}`;

    if (source === "ai8") {
        return {
            label: value,
            value,
            origId: trimmed,
            channel: "ai8",
            attr: { providerName: "ai8", custom: true },
            _source: "ai8",
            _custom: true,
        };
    }
    if (source === "gptall") {
        return {
            label: value,
            value,
            origId: trimmed,
            channel: "gpt-all",
            attr: { providerName: "gpt-all", custom: true },
            _source: "gptall",
            _actualModel: trimmed,
            _custom: true,
        };
    }
    if (source === "freegpt") {
        return {
            label: value,
            value,
            origId: trimmed,
            channel: "freegpt",
            attr: { providerName: "freegpt", custom: true },
            _source: "freegpt",
            _actualModel: trimmed,
            _custom: true,
        };
    }
    if (source === LSS_CHANNEL_NAME) {
        const aggregated = toLssAggregatedModel({ value: trimmed });
        if (!aggregated) {
            return null;
        }
        aggregated.attr = { ...aggregated.attr, custom: true };
        aggregated._custom = true;
        return aggregated;
    }

    const channel = (config.customChannels || []).find(c => c.name === source);
    if (!channel) {
        return null;
    }
    return {
        label: value,
        value,
        origId: trimmed,
        channel: channel.name,
        attr: { providerName: channel.name, custom: true },
        _source: channel.name,
        _actualModel: trimmed,
        _custom: true,
    };
}

function withCustomModels(models, config) {
    const base = Array.isArray(models) ? models : [];
    const merged = [...base];
    const sources = [
        "ai8",
        "gptall",
        "freegpt",
        LSS_CHANNEL_NAME,
        ...(config.customChannels || []).map(channel => channel.name),
    ];

    for (const source of sources) {
        for (const name of customModelConfigList(config, source)) {
            const entry = buildCustomModelEntry(config, source, name);
            if (!entry) {
                continue;
            }
            // Skip when an upstream catalog entry already carries this model.
            if (merged.some(m => m._source === entry._source && (m.origId || m.value) === entry.origId)) {
                continue;
            }
            merged.push(entry);
        }
    }

    return merged;
}

/**
 * Route a bare (suffix-less) model name through the per-channel manual model
 * lists so freshly added models work immediately, before the 5-minute model
 * cache refreshes. AI8 custom names fall through: the default AI8 path plus
 * the handler-level fallback already covers them.
 */
function findCustomModelRoute(requestModel, config) {
    const name = String(requestModel || "").trim();
    if (!name || name.includes("【")) {
        return null;
    }

    if (
        config.gptallEnabled !== false &&
        config.gptallAuthToken &&
        isChannelCustomModel(config, "gptall", name)
    ) {
        return {
            targetChannel: { protocol: "gptall", name: "gpt-all" },
            actualModel: name,
            toolSupported: null,
        };
    }

    if (
        config.freegptEnabled !== false &&
        config.freegptUuid &&
        isChannelCustomModel(config, "freegpt", name)
    ) {
        return {
            targetChannel: { protocol: "freegpt", name: "freegpt" },
            actualModel: name,
            toolSupported: null,
        };
    }

    if (
        config.lsshirtaiEnabled === true &&
        config.lsshirtaiAuthToken &&
        isChannelCustomModel(config, LSS_CHANNEL_NAME, name)
    ) {
        return {
            targetChannel: { protocol: LSS_CHANNEL_NAME, name: LSS_CHANNEL_NAME },
            actualModel: name,
            toolSupported: false,
        };
    }

    for (const channel of config.customChannels || []) {
        if (!channel.enabled) {
            continue;
        }
        if ((Array.isArray(channel.customModels) ? channel.customModels : []).includes(name)) {
            return { targetChannel: channel, actualModel: name, toolSupported: null };
        }
    }

    return null;
}

let modelCache = {
    models: [],
    timestamp: 0,
    ttl: 1000 * 60 * 5 // 5 minutes cache
};

let resolutionCache = new Map();

function clearResolutionCache() {
    resolutionCache = new Map();
}

// Drop the aggregated model pool and per-model routing cache so the next
// read rebuilds them with the latest config (e.g. after adding a manual
// model or editing channels).
function invalidateModelPool() {
    modelCache = {
        models: [],
        timestamp: 0,
        ttl: modelCache.ttl
    };
    clearResolutionCache();
}

let modelRefreshTask = null;

function serveAggregatedModels(config, forAdmin) {
    return filterCachedModels(withCustomModels(modelCache.models, config), config, forAdmin);
}

function startAggregation(client, config, logger, forAdmin, forceRefresh) {
    const task = aggregateUpstreamModels(client, config, logger, forAdmin, forceRefresh).finally(() => {
        if (modelRefreshTask === task) {
            modelRefreshTask = null;
        }
    });
    modelRefreshTask = task;
    return task;
}

async function fetchAggregatedModels(client, config, forceRefresh, logger, forAdmin = false) {
    const cachePopulated = modelCache.models.length > 0;
    const cacheFresh = cachePopulated && Date.now() - modelCache.timestamp < modelCache.ttl;

    if (cacheFresh && !forceRefresh) {
        return serveAggregatedModels(config, forAdmin);
    }

    // The admin's manual refresh must return fresh upstream data, and an
    // empty pool (startup or after invalidation) has nothing to serve yet —
    // both wait for a real aggregation. Concurrent callers join the in-flight
    // task instead of stacking duplicate upstream fetches.
    if (forceRefresh) {
        await startAggregation(client, config, logger, forAdmin, true);
        return serveAggregatedModels(config, forAdmin);
    }

    if (!cachePopulated) {
        if (!modelRefreshTask) {
            startAggregation(client, config, logger, forAdmin, false);
        }
        await modelRefreshTask;
        return serveAggregatedModels(config, forAdmin);
    }

    // Pool is stale but usable: serve it immediately and refresh in the
    // background so client model listings never block on slow upstreams
    // (the AI8 draw-models scrape chain alone can take 30s+).
    if (!modelRefreshTask) {
        startAggregation(client, config, logger, forAdmin, false).catch(() => {});
    }
    return serveAggregatedModels(config, forAdmin);
}

async function aggregateUpstreamModels(client, config, logger, forAdmin = false, forceRefresh = false) {
    const fetchTasks = [];
    // Admin listings may inspect the catalog before the channel is enabled so
    // the whitelist/blacklist can be prepared. Client listings stay hidden
    // until the channel is actually turned on.
    const lssRequested =
        Boolean(config.lsshirtaiAuthToken) && (config.lsshirtaiEnabled === true || forAdmin === true);

    if (config.ai8Enabled !== false) {
        fetchTasks.push(
            client.fetchModels({ forceRefresh })
                .then(rawAi8Models => rawAi8Models.map(m => ({ ...m })))
                .catch(e => {
                    if (logger) logger.warn("Failed to fetch AI8 models", { error: String(e) });
                    return [];
                })
        );
        if (typeof client.fetchDrawModels === "function") {
            if (forceRefresh) {
                // Manual refresh: wait for the real scrape so the admin sees
                // genuinely fresh data.
                fetchTasks.push(
                    client.fetchDrawModels(true)
                        .then(drawModels => (Array.isArray(drawModels) && drawModels.length > 0 ? drawModels : AI8_DRAW_MODELS))
                        .catch(e => {
                            if (logger) logger.warn("Failed to scrape AI8 draw models", { error: String(e) });
                            return AI8_DRAW_MODELS;
                        })
                );
            } else {
                // Automatic refresh: the scrape chain (page -> app bundle ->
                // each chunk, sequential, 15s timeout each) can take 30s+, so
                // serve the known list right away and scrape in the
                // background; the next aggregation picks up the result.
                const knownDrawModels = client._drawModelsCache?.models?.length > 0
                    ? client._drawModelsCache.models
                    : AI8_DRAW_MODELS;
                fetchTasks.push(Promise.resolve(knownDrawModels));
                client.fetchDrawModels(false).catch(e => {
                    if (logger) logger.warn("Background AI8 draw model scrape failed", { error: String(e) });
                });
            }
        } else {
            fetchTasks.push(Promise.resolve(AI8_DRAW_MODELS));
        }
    }

    if (config.gptallEnabled !== false && config.gptallAuthToken) {
        fetchTasks.push(
            getGptAllModelClient(config).fetchModels()
                .then(gptallModels => gptallModels || [])
                .catch(e => {
                    if (logger) logger.warn("Failed to fetch gpt-all models", { error: String(e) });
                    return [];
                })
        );
    }

    if (config.freegptEnabled !== false && config.freegptUuid) {
        fetchTasks.push(
            getFreeGptModelClient(config).fetchModels()
                .then(freegptModels => freegptModels || [])
                .catch(e => {
                    if (logger) logger.warn("Failed to fetch freegpt models", { error: String(e) });
                    return [];
                })
        );
    }

    if (lssRequested) {
        fetchTasks.push(
            getLssModelClient(config).fetchModels()
                .then(lssModels => (lssModels || []).filter(isLssChatModel))
                .catch(e => {
                    if (logger) logger.warn("Failed to fetch lsshirtai models", { error: String(e) });
                    return [];
                })
        );
    }

    const customChannelTasks = (config.customChannels || [])
        .filter(channel => channel.enabled)
        .map(channel => {
            let safeBase = channel.baseUrl.trim().replace(/\/+$/, "");
            if (safeBase.endsWith("/chat/completions")) {
                safeBase = safeBase.replace("/chat/completions", "");
            }
            const endpoint = safeBase.endsWith("/v1") ? `${safeBase}/models` : `${safeBase}/v1/models`;
            return fetch(endpoint, {
                headers: { "Authorization": `Bearer ${channel.apiKey}` },
                signal: AbortSignal.timeout(5000)
            })
                .then(res => (res.ok ? res.json() : null))
                .then(data => ({
                    channel,
                    models: (data && Array.isArray(data.data)) ? data.data : [],
                }))
                .catch(e => {
                    if (logger) logger.warn(`Failed to fetch models for channel ${channel.name}`, { error: String(e) });
                    return { channel, models: [] };
                });
        });

    const ai8Requested = config.ai8Enabled !== false;
    const gptallRequested = config.gptallEnabled !== false && config.gptallAuthToken;
    const freegptRequested = config.freegptEnabled !== false && config.freegptUuid;

    // Run ai8, gptall, freegpt and all custom channels in parallel.
    // Resolve by index instead of positional destructuring so an absent gptall
    // task cannot swallow the first custom-channel result (which is a
    // `{ channel, models }` object, not an array).
    const results = await Promise.all([...fetchTasks, ...customChannelTasks]);

    let offset = 0;
    const ai8Models = ai8Requested ? results[offset++] || [] : [];
    const ai8DrawModels = ai8Requested ? results[offset++] || [] : [];
    let gptallModels = gptallRequested ? results[offset++] || [] : [];
    let freegptModels = freegptRequested ? results[offset++] || [] : [];
    const lssModels = lssRequested ? results[offset++] || [] : [];
    const customResults = results.slice(offset);
    if (!Array.isArray(gptallModels)) {
        gptallModels = [];
    }
    if (!Array.isArray(freegptModels)) {
        freegptModels = [];
    }

    const allModels = [];

    for (const m of ai8Models) {
        const value = String(m.value || "").trim();
        if (!value) continue;
        allModels.push({
            ...m,
            _source: "ai8",
            origId: value.replace(/【AI8直连】$/, ''),
            value: `${value.replace(/【AI8直连】$/, '')}【AI8直连】`,
            label: `${value.replace(/【AI8直连】$/, '')}【AI8直连】`,
        });
    }

    if (ai8Requested && !allModels.some(m => m._source === "ai8" && m.origId === "gpt-image-2")) {
        allModels.push({
            label: "gpt-image-2【AI8直连】",
            value: "gpt-image-2【AI8直连】",
            origId: "gpt-image-2",
            attr: { providerName: "ai8", capabilities: { image: true } },
            _source: "ai8",
        });
    }

    if (ai8Requested) {
        for (const drawModel of ai8DrawModels) {
            if (!drawModel || !drawModel.version) continue;
            if (allModels.some(m => m._source === "ai8" && m.origId === drawModel.version)) continue;
            const modelId = `${drawModel.version}【AI8直连】`;
            allModels.push({
                label: modelId,
                value: modelId,
                origId: drawModel.version,
                attr: { providerName: "ai8", capabilities: { image: true } },
                _source: "ai8",
                _isDraw: true,
            });
        }
    }

    for (const gptallModel of (gptallModels || [])) {
        const origId = String(gptallModel.value || gptallModel.model || "").trim();
        if (origId && !allModels.some(m => m._source === "gptall" && m.origId === origId)) {
            const modelId = `${origId}【gpt-all】`;
            allModels.push({
                label: modelId,
                value: modelId,
                origId,
                channel: "gpt-all",
                attr: { providerName: "gpt-all" },
                _source: "gptall",
                _actualModel: origId,
                _isToolSupported: gptallModel.isToolSupported === true,
            });
        }
    }

    for (const freegptModel of (freegptModels || [])) {
        const origId = String(freegptModel.value || freegptModel.model || "").trim();
        if (origId && !allModels.some(m => m._source === "freegpt" && m.origId === origId)) {
            const modelId = `${origId}【freegpt】`;
            allModels.push({
                label: modelId,
                value: modelId,
                origId,
                channel: "freegpt",
                attr: { providerName: "freegpt" },
                _source: "freegpt",
                _actualModel: origId,
            });
        }
    }

    for (const lssModel of (lssModels || [])) {
        const aggregated = toLssAggregatedModel(lssModel);
        if (aggregated && !allModels.some(m => m._source === LSS_CHANNEL_NAME && m.origId === aggregated.origId)) {
            allModels.push(aggregated);
        }
    }

    for (const { channel, models } of customResults) {
        for (const m of models) {
            if (!m || m.id === undefined || m.id === null) continue;
            const modelId = `${m.id}【${channel.name}】`;
            allModels.push({
                label: modelId,
                value: modelId,
                origId: m.id,
                channel: channel.name,
                attr: { providerName: channel.name },
                _source: channel.name,
                _actualModel: m.id
            });
        }
    }

    modelCache = {
        models: allModels,
        timestamp: Date.now(),
        ttl: modelCache.ttl
    };

    clearResolutionCache();

    return filterCachedModels(withCustomModels(allModels, config), config, forAdmin);
}

function filterCachedModels(models, config, forAdmin) {
    if (forAdmin) return models;
    const globalBlacklist = Array.isArray(config.blacklistedModels) && config.blacklistedModels.length > 0 ? config.blacklistedModels : null;
    return models.filter(m => {
        if (globalBlacklist !== null && globalBlacklist.includes(m.value || m.origId)) return false;
        // Manually added models skip the whitelist but still honor the
        // channel-level blacklist and the channel's on/off switch.
        if (m._custom === true) {
            if (m._source === "ai8") {
                if (config.ai8Enabled === false) return false;
                return !(Array.isArray(config.ai8BlacklistedModels) ? config.ai8BlacklistedModels : []).includes(m.origId);
            }
            if (m._source === "gptall") {
                if (config.gptallEnabled === false) return false;
                return !(Array.isArray(config.gptallBlacklistedModels) ? config.gptallBlacklistedModels : []).includes(m.origId);
            }
            if (m._source === "freegpt") {
                if (config.freegptEnabled === false) return false;
                return !(Array.isArray(config.freegptBlacklistedModels) ? config.freegptBlacklistedModels : []).includes(m.origId);
            }
            if (m._source === LSS_CHANNEL_NAME) {
                if (config.lsshirtaiEnabled !== true) return false;
                return !lssModelIdMatches(config.lsshirtaiBlacklistedModels, m.origId);
            }
            const channel = (config.customChannels || []).find(c => c.name === m._source);
            if (!channel || !channel.enabled) return false;
            return !(Array.isArray(channel.blacklistedModels) ? channel.blacklistedModels : []).includes(m.origId);
        }
        if (m._source === "ai8") {
            const ai8Whitelist = Array.isArray(config.ai8AllowedModels) && config.ai8AllowedModels.length > 0 ? config.ai8AllowedModels : null;
            if (ai8Whitelist !== null && !ai8Whitelist.includes(m.origId)) return false;
            const ai8Blacklist = Array.isArray(config.ai8BlacklistedModels) && config.ai8BlacklistedModels.length > 0 ? config.ai8BlacklistedModels : null;
            if (ai8Blacklist !== null && ai8Blacklist.includes(m.origId)) return false;
            return true;
        }
        if (m._source === "gptall") {
            const gptallWhitelist = Array.isArray(config.gptallAllowedModels) && config.gptallAllowedModels.length > 0 ? config.gptallAllowedModels : null;
            if (gptallWhitelist !== null && !gptallWhitelist.includes(m.origId)) return false;
            const gptallBlacklist = Array.isArray(config.gptallBlacklistedModels) && config.gptallBlacklistedModels.length > 0 ? config.gptallBlacklistedModels : null;
            if (gptallBlacklist !== null && gptallBlacklist.includes(m.origId)) return false;
            return true;
        }
        if (m._source === "freegpt") {
            const freegptWhitelist = Array.isArray(config.freegptAllowedModels) && config.freegptAllowedModels.length > 0 ? config.freegptAllowedModels : null;
            if (freegptWhitelist !== null && !freegptWhitelist.includes(m.origId)) return false;
            const freegptBlacklist = Array.isArray(config.freegptBlacklistedModels) && config.freegptBlacklistedModels.length > 0 ? config.freegptBlacklistedModels : null;
            if (freegptBlacklist !== null && freegptBlacklist.includes(m.origId)) return false;
            return true;
        }
        if (m._source === LSS_CHANNEL_NAME) {
            if (config.lsshirtaiEnabled !== true) return false;
            const lssWhitelist = Array.isArray(config.lsshirtaiAllowedModels) && config.lsshirtaiAllowedModels.length > 0 ? config.lsshirtaiAllowedModels : null;
            if (lssWhitelist !== null && !lssModelIdMatches(lssWhitelist, m.origId)) return false;
            const lssBlacklist = Array.isArray(config.lsshirtaiBlacklistedModels) && config.lsshirtaiBlacklistedModels.length > 0 ? config.lsshirtaiBlacklistedModels : null;
            if (lssBlacklist !== null && lssModelIdMatches(lssBlacklist, m.origId)) return false;
            return true;
        }
        const channel = (config.customChannels || []).find(c => c.name === m._source);
        if (!channel) return false;
        if (!channel.enabled) return false;
        const whitelist = Array.isArray(channel.models) && channel.models.length > 0 ? channel.models : null;
        if (whitelist !== null && !whitelist.includes(m.origId)) return false;
        const blacklist = Array.isArray(channel.blacklistedModels) && channel.blacklistedModels.length > 0 ? channel.blacklistedModels : null;
        if (blacklist !== null && blacklist.includes(m.origId)) return false;
        return true;
    });
}

function isBlacklisted(requestModel, config, targetChannel) {
    if (targetChannel && targetChannel.name === "gpt-all") {
        const list = Array.isArray(config.gptallBlacklistedModels) ? config.gptallBlacklistedModels : [];
        return list.includes(requestModel);
    }
    if (targetChannel && targetChannel.name === "freegpt") {
        const list = Array.isArray(config.freegptBlacklistedModels) ? config.freegptBlacklistedModels : [];
        return list.includes(requestModel);
    }
    if (targetChannel && targetChannel.name === LSS_CHANNEL_NAME) {
        const list = Array.isArray(config.lsshirtaiBlacklistedModels) ? config.lsshirtaiBlacklistedModels : [];
        return lssModelIdMatches(list, requestModel);
    }
    if (targetChannel) {
        const list = Array.isArray(targetChannel.blacklistedModels) ? targetChannel.blacklistedModels : [];
        return list.includes(requestModel);
    }
    const ai8List = Array.isArray(config.ai8BlacklistedModels) ? config.ai8BlacklistedModels : [];
    return ai8List.includes(requestModel);
}

async function resolveTargetChannel(requestModel, config, client, logger) {
    const cached = resolutionCache.get(requestModel);
    if (cached && Date.now() - cached.timestamp < modelCache.ttl) {
        return cached.result;
    }

    const result = await resolveTargetChannelUncached(requestModel, config, client, logger);
    resolutionCache.set(requestModel, { result, timestamp: Date.now() });
    return result;
}

async function resolveTargetChannelUncached(requestModel, config, client, logger) {
    let actualModel = requestModel;
    let targetChannel = null;
    let toolSupported = null;

    // 1. Explicitly matched by suffix
    const match = requestModel.match(/^(.*?)【(.*?)】$/);
    if (match) {
        actualModel = match[1];
        const channelName = match[2];
        const customChannels = config.customChannels || [];
        targetChannel = customChannels.find(c => c.name === channelName && c.enabled);
        if (targetChannel) {
            return { targetChannel, actualModel, toolSupported: null };
        }
        if (channelName === "AI8直连" || channelName === "ai8") {
            return { targetChannel: null, actualModel, toolSupported: null };
        }
        if (channelName === "gpt-all" || channelName === "gptall") {
            return {
                targetChannel: { protocol: "gptall", name: "gpt-all" },
                actualModel,
                toolSupported: lookupGptAllToolSupport(actualModel, requestModel),
            };
        }
        if (channelName === "freegpt" || channelName === "free-gpt") {
            return {
                targetChannel: { protocol: "freegpt", name: "freegpt" },
                actualModel,
                toolSupported: null,
            };
        }
        if (channelName === LSS_CHANNEL_NAME || channelName === "lss") {
            return {
                targetChannel: { protocol: LSS_CHANNEL_NAME, name: LSS_CHANNEL_NAME },
                actualModel,
                toolSupported: false,
            };
        }
    }

    // 1.5 Bare model names added manually to a channel route directly from
    // config, so they work before the shared model cache refreshes.
    const customRoute = findCustomModelRoute(requestModel, config);
    if (customRoute) {
        return customRoute;
    }
    
    // 2. Try to find in cache for unprefixed models
    if (!targetChannel) {
        if (modelCache.models.length === 0 || Date.now() - modelCache.timestamp >= modelCache.ttl) {
            if (client) {
                await fetchAggregatedModels(client, config, false, logger);
            }
        }

        const cached = modelCache.models.find(m => m.value === requestModel || m.origId === requestModel);
        if (cached && cached._source === "gptall") {
            targetChannel = { protocol: "gptall", name: "gpt-all" };
            actualModel = cached._actualModel || requestModel;
            toolSupported = cached._isToolSupported === true;
        } else if (cached && cached._source === "freegpt") {
            targetChannel = { protocol: "freegpt", name: "freegpt" };
            actualModel = cached._actualModel || requestModel;
        } else if (cached && cached._source === LSS_CHANNEL_NAME && config.lsshirtaiEnabled === true) {
            targetChannel = { protocol: LSS_CHANNEL_NAME, name: LSS_CHANNEL_NAME };
            actualModel = cached._actualModel || requestModel;
            toolSupported = false;
        } else if (cached && cached._source !== "ai8") {
            const customChannels = config.customChannels || [];
            targetChannel = customChannels.find(c => c.name === cached._source && c.enabled);
            if (targetChannel) {
                actualModel = cached._actualModel || requestModel;
            }
        }
    }

    return { targetChannel, actualModel, toolSupported };
}

function lookupGptAllToolSupport(actualModel, requestModel) {
    const cached = modelCache.models.find(m => m._source === "gptall" && (m.origId === actualModel || m.origId === requestModel));
    if (!cached) {
        return null;
    }
    return cached._isToolSupported === true;
}

/**
 * JSON Schema keywords that Gemini's `function_declarations` parameters accept.
 * Gemini only supports a subset of OpenAPI Schema; anything outside this set
 * makes the upstream reject the request (e.g. `propertyNames`, `$ref`,
 * `pattern`, `oneOf`). Shape/type information needed for tool calling is kept.
 */
const GEMINI_SCHEMA_VALUE_KEYS = new Set([
    "type", "format", "title", "description", "nullable", "enum", "default",
    "example", "required", "propertyOrdering",
    "minItems", "maxItems", "minimum", "maximum",
]);

function sanitizeJsonSchema(node, depth = 0) {
    if (depth > 12 || node === null || typeof node !== "object") {
        return node;
    }

    if (Array.isArray(node)) {
        return node.map(item => sanitizeJsonSchema(item, depth + 1));
    }

    const sanitized = {};

    for (const [key, value] of Object.entries(node)) {
        if (GEMINI_SCHEMA_VALUE_KEYS.has(key)) {
            sanitized[key] = value;
            continue;
        }

        if (key === "properties") {
            if (value && typeof value === "object" && !Array.isArray(value)) {
                const properties = {};
                for (const [propertyName, propertySchema] of Object.entries(value)) {
                    properties[propertyName] = sanitizeJsonSchema(propertySchema, depth + 1);
                }
                sanitized.properties = properties;
            }
            continue;
        }

        if (key === "items" || key === "additionalProperties") {
            sanitized[key] = sanitizeJsonSchema(value, depth + 1);
            continue;
        }

        if (key === "anyOf") {
            sanitized.anyOf = Array.isArray(value)
                ? value.map(item => sanitizeJsonSchema(item, depth + 1))
                : value;
            continue;
        }

        // Everything else (propertyNames, $schema, pattern, oneOf, const, ...)
        // is not understood by Gemini and would reject the whole request.
    }

    return sanitized;
}

function sanitizeToolSchemas(tools) {
    return tools
        .map(tool => {
            if (!tool || typeof tool !== "object") {
                return tool;
            }

            const fn = tool.function;
            if (!fn || typeof fn !== "object" || !fn.parameters || typeof fn.parameters !== "object") {
                return tool;
            }

            return {
                ...tool,
                function: {
                    ...fn,
                    parameters: sanitizeJsonSchema(fn.parameters),
                },
            };
        })
        .filter(Boolean);
}

async function proxyToCustomChannel(req, res, targetChannel, actualModel, body, buildErrorPayload, isNativeClaude = false, logger = null) {
    let safeBase = targetChannel.baseUrl.trim().replace(/\/+$/, "");
    
    if (isNativeClaude) {
        if (safeBase.endsWith("/messages")) safeBase = safeBase.replace("/messages", "");
    } else {
        if (safeBase.endsWith("/chat/completions")) safeBase = safeBase.replace("/chat/completions", "");
    }
    
    let endpoint = "";
    if (isNativeClaude) {
        endpoint = safeBase.endsWith("/v1") ? `${safeBase}/messages` : (safeBase.endsWith("/") ? `${safeBase}v1/messages` : `${safeBase}/v1/messages`);
    } else {
        endpoint = safeBase.endsWith("/v1") ? `${safeBase}/chat/completions` : (safeBase.endsWith("/") ? `${safeBase}v1/chat/completions` : `${safeBase}/v1/chat/completions`);
    }
    
    const proxyBody = { ...body, model: actualModel };

    if (!isNativeClaude && Array.isArray(proxyBody.tools)) {
        // Gemini-backed upstreams translate tools into `function_declarations`
        // and only accept a subset of JSON Schema; keywords such as
        // `propertyNames` make them reject the whole request with a 400.
        proxyBody.tools = sanitizeToolSchemas(proxyBody.tools);
    }

    if (targetChannel.stripReasoning && Array.isArray(proxyBody.messages)) {
        // Strict upstreams (e.g. NVIDIA) reject the DeepSeek-style
        // reasoning_content field; opt-in per channel via stripReasoning.
        proxyBody.messages = proxyBody.messages.map(message => {
            if (message && typeof message === "object" && "reasoning_content" in message) {
                const { reasoning_content, ...rest } = message;
                return rest;
            }
            return message;
        });
    }
    
    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    try {
        const reqHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${targetChannel.apiKey}`
        };
        if (isNativeClaude) {
            reqHeaders["x-api-key"] = targetChannel.apiKey;
            reqHeaders["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
            if (req.headers["anthropic-beta"]) {
                reqHeaders["anthropic-beta"] = req.headers["anthropic-beta"];
            }
        }
    
        const upstreamRes = await fetch(endpoint, {
            method: "POST",
            headers: reqHeaders,
            body: JSON.stringify(proxyBody),
            signal: abortController.signal
        });

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            if (logger) {
                logger.warn("Custom channel upstream error", {
                    channel: targetChannel.name || targetChannel.id || "unknown",
                    model: actualModel,
                    status: upstreamRes.status,
                    body: String(errText).slice(0, 400),
                });
            }
            res.status(upstreamRes.status).send(errText);
            return;
        }

        if (body.stream) {
            res.status(upstreamRes.status);
            const ct = upstreamRes.headers.get("content-type");
            if (ct) res.setHeader("content-type", ct);
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("Connection", "keep-alive");
            if (typeof res.flushHeaders === "function") {
                res.flushHeaders();
            }
            
            const reader = upstreamRes.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                        res.write(Buffer.from(value));
                    }
                }
            } catch (streamErr) {
                if (logger) {
                    logger.warn("Custom channel stream interrupted", {
                        channel: targetChannel.name || targetChannel.id || "unknown",
                        model: actualModel,
                        error: streamErr.message,
                    });
                }
                throw streamErr;
            } finally {
                reader.releaseLock();
            }
            res.end();
        } else {
            const rawText = await upstreamRes.text();
            res.status(upstreamRes.status);
            const ct = upstreamRes.headers.get("content-type");
            if (ct) res.setHeader("content-type", ct);
            try {
                const data = JSON.parse(rawText);
                res.json(data);
            } catch (jsonErr) {
                res.send(rawText);
            }
        }
    } catch (e) {
        if (logger && !abortController.signal.aborted) {
            logger.error("Custom channel proxy failed", {
                channel: targetChannel.name || targetChannel.id || "unknown",
                model: actualModel,
                error: e.message,
            });
        }
        if (abortController.signal.aborted) return res.end();
        if (!res.headersSent) {
            const errJson = typeof buildErrorPayload === "function"
                ? buildErrorPayload(502, `Error proxying to channel: ${e.message}`, "server_error")
                : { error: { message: e.message }};
            res.status(502).json(errJson);
        }
    }
}

module.exports = { buildGptAllClient, buildFreeGptClient, buildLssClient, clearResolutionCache, fetchAggregatedModels, invalidateModelPool, isChannelCustomModel, isLssChatModel, toLssAggregatedModel, withCustomModels, proxyToCustomChannel, resolveTargetChannel, isBlacklisted, filterCachedModels, sanitizeToolSchemas, LSS_CHANNEL_NAME, LSS_MODEL_SUFFIX };
