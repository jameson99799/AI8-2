"use strict";

let modelCache = {
    models: [],
    timestamp: 0,
    ttl: 1000 * 60 * 5 // 5 minutes cache
};

async function fetchAggregatedModels(client, config, forceRefresh, logger) {
    if (!forceRefresh && modelCache.models.length > 0 && Date.now() - modelCache.timestamp < modelCache.ttl) {
        return modelCache.models;
    }

    let ai8Models = [];
    if (config.ai8Enabled !== false) {
        try {
            ai8Models = await client.fetchModels({ forceRefresh });
            ai8Models.forEach(m => m._source = "ai8");
        } catch (e) {
            if (logger) logger.warn("Failed to fetch AI8 models", { error: String(e) });
        }
    }
    
    let allModels = [...ai8Models];
    
    for (const channel of (config.customChannels || [])) {
        if (!channel.enabled) continue;
        
        try {
            const endpoint = channel.baseUrl.endsWith("/v1") ? `${channel.baseUrl}/models` : `${channel.baseUrl}/v1/models`;
            const res = await fetch(endpoint, {
                headers: { "Authorization": `Bearer ${channel.apiKey}` },
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.data)) {
                    for (const m of data.data) {
                        const conflictOrDuplicate = allModels.some(existing => existing.value === m.id || existing.id === m.id);
                        const modelId = conflictOrDuplicate ? `${m.id}【${channel.name}】` : m.id;
                        
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
            }
        } catch (e) {
            if (logger) logger.warn(`Failed to fetch models for channel ${channel.name}`, { error: String(e) });
        }
    }
    
    modelCache = {
        models: allModels,
        timestamp: Date.now(),
        ttl: modelCache.ttl
    };
    
    return allModels;
}

function resolveTargetChannel(requestModel, config) {
    let actualModel = requestModel;
    let targetChannel = null;

    // 1. Explicitly matched by suffix
    const match = requestModel.match(/^(.*?)【(.*?)】$/);
    if (match) {
        actualModel = match[1];
        const channelName = match[2];
        const customChannels = config.customChannels || [];
        targetChannel = customChannels.find(c => c.name === channelName && c.enabled);
        if (targetChannel) {
            return { targetChannel, actualModel };
        }
    }
    
    // 2. Try to find in cache for unprefixed models
    if (!targetChannel) {
        const cached = modelCache.models.find(m => m.value === requestModel || m.origId === requestModel);
        if (cached && cached._source !== "ai8") {
            const customChannels = config.customChannels || [];
            targetChannel = customChannels.find(c => c.name === cached._source && c.enabled);
            if (targetChannel) {
                actualModel = cached._actualModel || requestModel;
            }
        }
    }

    return { targetChannel, actualModel };
}

async function proxyToCustomChannel(req, res, targetChannel, actualModel, body, buildErrorPayload) {
    const endpoint = targetChannel.baseUrl.endsWith("/v1") ? `${targetChannel.baseUrl}/chat/completions` : `${targetChannel.baseUrl}/v1/chat/completions`;
    const proxyBody = { ...body, model: actualModel };
    
    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    try {
        const upstreamRes = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${targetChannel.apiKey}`
            },
            body: JSON.stringify(proxyBody),
            signal: abortController.signal
        });

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            res.status(upstreamRes.status).send(errText);
            return;
        }

        if (body.stream) {
            res.status(upstreamRes.status);
            const ct = upstreamRes.headers.get("content-type");
            if (ct) res.setHeader("content-type", ct);
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("Connection", "keep-alive");
            
            const decoder = new TextDecoder();
            for await (const chunk of upstreamRes.body) {
                res.write(decoder.decode(chunk, { stream: true }));
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
                console.log(SENDING EMPTY TEXT!!! HTTP  CT ); res.send(rawText);
            }
        }
    } catch (e) {
        if (abortController.signal.aborted) return res.end();
        if (!res.headersSent) {
            const errJson = typeof buildErrorPayload === "function" 
                ? buildErrorPayload(502, `Error proxying to channel: ${e.message}`, "server_error")
                : { error: { message: e.message }};
            res.status(502).json(errJson);
        }
    }
}

module.exports = { fetchAggregatedModels, proxyToCustomChannel, resolveTargetChannel };
