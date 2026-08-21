"use strict";

const AI8_DRAW_MODELS = [
    { model: "openai-draw", version: "gpt-image-2" },
    { model: "openai-draw", version: "gpt-image-1-5" },
    { model: "openai-draw", version: "gpt-image-1" },
    { model: "openai-draw", version: "dall-e-3" },
    { model: "google-draw", version: "nano-banana-pro" },
    { model: "google-draw", version: "nano-banana-2" },
    { model: "google-draw", version: "nano-banana-2-lite" },
    { model: "google-draw", version: "nano-banana" },
    { model: "xai-draw", version: "grok-imagine-image-quality" },
    { model: "xai-draw", version: "grok-imagine-image" },
    { model: "qwen-draw", version: "qwen-image-2.0-pro" },
    { model: "qwen-draw", version: "qwen-image-2.0" },
    { model: "wan-draw", version: "wan2.7-image-pro" },
    { model: "wan-draw", version: "wan2.7-image" },
    { model: "wan-draw", version: "wan2.6-t2i" },
    { model: "kling-draw", version: "kling-omni-image" },
    { model: "kling-draw", version: "kling-v3-omni" },
    { model: "kling-draw", version: "kling-kolors-v3" },
    { model: "kling-draw", version: "kling-kolors-v2-1" },
    { model: "kling-draw", version: "kling-kolors-v2" },
    { model: "minimax-draw", version: "image-01" },
    { model: "minimax-draw", version: "image-01-live" },
    { model: "volc-draw", version: "volc-img" },
    { model: "volc-draw", version: "volc-v5-lite" },
    { model: "volc-draw", version: "volc-v5-pro" },
    { model: "volc-draw", version: "volc-v4-5" },
    { model: "volc-draw", version: "volc-v4" },
    { model: "mj", version: "mj" },
    { model: "niji", version: "niji" },
];

function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
}

function sizeToAspectRatio(size) {
    const match = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(String(size || "").trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return null;
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function resolveDrawModel(name) {
    const normalized = String(name || "").trim().replace(/【AI8直连】$/, "").toLowerCase();
    if (!normalized) return null;
    return AI8_DRAW_MODELS.find(entry => entry.version === normalized) || null;
}

const DRAW_SCRAPER_TTL_MS = 30 * 60 * 1000;

function parseDrawVersionsFromChunk(js) {
    const versions = [];
    const blockRe = /function\(e\)\{return\s+((?:e\.[A-Za-z0-9_]+=`[^`]*`,?\s*)+e?)\}\(\{\}\)/g;
    let block;
    while ((block = blockRe.exec(js))) {
        const pairRe = /e\.[A-Za-z0-9_]+=`([^`]*)`/g;
        let pair;
        while ((pair = pairRe.exec(block[1]))) {
            versions.push(pair[1]);
        }
    }
    return versions;
}

function classifyDrawProvider(version) {
    const value = String(version || "").trim();
    if (!/^[a-z0-9][a-z0-9.\-]*$/.test(value)) return null;
    if (/^(gpt-image|dall-e)/.test(value)) return "openai-draw";
    if (/^nano-banana/.test(value)) return "google-draw";
    if (/^grok-imagine/.test(value)) return "xai-draw";
    if (/^qwen-image/.test(value)) return "qwen-draw";
    if (/^wan\d/.test(value)) return "wan-draw";
    if (/^kling-/.test(value)) return "kling-draw";
    if (/^image-01/.test(value)) return "minimax-draw";
    if (/^volc-/.test(value)) return value === "volc-text" ? null : "volc-draw";
    return null;
}

class AI8Client {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl || "https://ai8.rcouyi.com/api").replace(/\/+$/, "");
        this.authToken = String(options.authToken || "").trim();
        this.xAppVersion = String(options.xAppVersion || "3.0.1").trim();
        this.defaultModel = String(options.defaultModel || "").trim();
        this.requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
            ? Number(options.requestTimeoutMs)
            : 300000;
        this.modelCacheTtlMs = Number.isFinite(Number(options.modelCacheTtlMs))
            ? Number(options.modelCacheTtlMs)
            : 300000;
        this.templateCache = {
            data: null,
            expiresAt: 0,
        };

        if (!this.authToken) {
            throw new Error("AI8_AUTH_TOKEN is required.");
        }
    }

    async fetchTemplate({ forceRefresh = false } = {}) {
        const now = Date.now();
        if (!forceRefresh && this.templateCache.data && now < this.templateCache.expiresAt) {
            return this.templateCache.data;
        }

        const data = await this.requestJson("/chat/tmpl");
        this.templateCache = {
            data,
            expiresAt: now + this.modelCacheTtlMs,
        };
        return data;
    }

    async fetchModels(options = {}) {
        const template = await this.fetchTemplate(options);
        return Array.isArray(template?.models) ? template.models : [];
    }

    async listSessions(query = {}) {
        return this.requestJson("/chat/session", {
            query,
        });
    }

    async listRecords(sessionId, query = {}) {
        const normalizedSessionId = Number(sessionId);
        if (!Number.isFinite(normalizedSessionId)) {
            throw this._buildError("AI8 session id must be numeric.", 400);
        }

        return this.requestJson(`/chat/record/${normalizedSessionId}`, {
            query,
        });
    }

    async deleteSession(sessionId) {
        const normalizedSessionId = Number(sessionId);
        if (!Number.isFinite(normalizedSessionId)) {
            throw this._buildError("AI8 session id must be numeric.", 400);
        }

        return this.requestJson(`/chat/session/${normalizedSessionId}`, {
            method: "DELETE",
        });
    }

    async submitDraw(options = {}) {
        const payload = {
            model: String(options.model || "openai-draw").trim() || "openai-draw",
            action: String(options.action || "IMAGINE").trim() || "IMAGINE",
            public: false,
            fast: options.fast === true,
            args: {
                version: String(options.version || "gpt-image-2").trim() || "gpt-image-2",
                area: String(options.area || "1024x1024").trim() || "1024x1024",
                output_max: Number.isFinite(Number(options.outputMax)) && Number(options.outputMax) > 0
                    ? Number(options.outputMax)
                    : 1,
                quality: String(options.quality || "high").trim() || "high",
                moderation: "auto",
                background: "auto",
            },
            prompt: String(options.prompt || ""),
        };
        const images = Array.isArray(options.images) ? options.images.filter(Boolean) : [];
        if (images.length > 0) {
            payload.images = images.map((image, index) => {
                if (typeof image === "string") {
                    return { base64: image, name: `image-${index + 1}.png` };
                }
                return image;
            });
        }
        return this.requestJson("/draw", {
            method: "POST",
            body: payload,
        });
    }

    async getDrawStatus(taskId) {
        const normalizedTaskId = String(taskId || "").trim();
        if (!normalizedTaskId) {
            throw this._buildError("AI8 draw task id is required.", 400);
        }
        return this.requestJson(`/draw/status/${encodeURIComponent(normalizedTaskId)}`);
    }

    async fetchDrawModels(forceRefresh = false) {
        if (!forceRefresh && this._drawModelsCache && Date.now() - this._drawModelsCache.timestamp < DRAW_SCRAPER_TTL_MS) {
            return this._drawModelsCache.models;
        }

        try {
            const origin = new URL(this.baseUrl).origin;
            const pageHtml = await this._scrapeText(`${origin}/draw`);
            const appName = pageHtml.match(/assets\/(app-[\w.-]+\.js)/)?.[1];
            if (!appName) {
                throw new Error("app bundle not found on /draw page");
            }
            const appJs = await this._scrapeText(`${origin}/assets/${appName}`);
            const chunkNames = [...new Set(
                [...appJs.matchAll(/assets\/(draw-[\w.-]+\.js)/g)].map(match => match[1])
            )];
            if (chunkNames.length === 0) {
                throw new Error("no draw chunks referenced in app bundle");
            }

            const versions = new Set(["mj", "niji"]);
            for (const chunkName of chunkNames) {
                const chunkJs = await this._scrapeText(`${origin}/assets/${chunkName}`);
                for (const version of parseDrawVersionsFromChunk(chunkJs)) {
                    versions.add(version);
                }
            }

            const models = [];
            for (const version of versions) {
                const provider = classifyDrawProvider(version);
                if (provider) {
                    models.push({ model: provider, version });
                }
            }
            for (const special of ["mj", "niji"]) {
                if (!models.some(entry => entry.version === special)) {
                    models.push({ model: special, version: special });
                }
            }
            if (models.length < 5) {
                throw new Error(`implausible draw model list (${models.length} entries)`);
            }

            this._drawModelsCache = { models, timestamp: Date.now() };
            return models;
        } catch (error) {
            this._drawModelsCache = { models: AI8_DRAW_MODELS.map(entry => ({ ...entry })), timestamp: Date.now() };
            return this._drawModelsCache.models;
        }
    }

    getDrawModel(name) {
        const normalized = String(name || "").trim().replace(/【AI8直连】$/, "").toLowerCase();
        if (!normalized) return null;
        const models = (this._drawModelsCache && Array.isArray(this._drawModelsCache.models))
            ? this._drawModelsCache.models
            : AI8_DRAW_MODELS;
        return models.find(entry => entry.version === normalized) || null;
    }

    async _scrapeText(url) {
        const response = await fetch(url, {
            headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
            throw new Error(`scrape ${url} failed with status ${response.status}`);
        }
        return response.text();
    }

    async resolveModel(model) {
        const requested = String(model || this.defaultModel || "").trim();
        if (!requested) {
            throw this._buildError("AI8 model is required.", 400);
        }

        const models = await this.fetchModels();
        const normalizedRequested = requested.toLowerCase();

        const exactMatch = models.find(item => String(item?.value || "").toLowerCase() === normalizedRequested);
        if (exactMatch) {
            return exactMatch;
        }

        const shortMatches = models.filter(item => {
            const shortName = String(item?.value || "").split("::").pop();
            return shortName && shortName.toLowerCase() === normalizedRequested;
        });

        if (shortMatches.length === 1) {
            return shortMatches[0];
        }

        if (shortMatches.length > 1) {
            throw this._buildError(
                `Model "${requested}" is ambiguous on AI8. Use the full provider-qualified model id instead.`,
                400
            );
        }

        throw this._buildError(`Model "${requested}" was not found on AI8.`, 400);
    }

    async createSession(options = {}) {
        const resolvedModel = await this.resolveModel(options.model);
        const payload = {
            mcp: Array.isArray(options.mcp) ? options.mcp : [],
            model: resolvedModel.value,
            plugins: options.plugins ?? null,
            rags: Array.isArray(options.rags) ? options.rags : [],
        };

        if (typeof options.name === "string" && options.name.trim()) {
            payload.name = options.name.trim();
        }

        if (typeof options.prompt === "string" && options.prompt.trim()) {
            payload.prompt = options.prompt;
        }

        if (Number.isFinite(Number(options.temperature))) {
            payload.temperature = Number(options.temperature);
        }

        if (Number.isFinite(Number(options.contextCount))) {
            payload.contextCount = Number(options.contextCount);
        }

        if (Number.isFinite(Number(options.maxToken))) {
            payload.maxToken = Number(options.maxToken);
        }

        return this.requestJson("/chat/session", {
            body: payload,
            method: "POST",
        });
    }

    buildSessionUpdatePayload(session, patch = {}) {
        return {
            contextCount: Number.isFinite(Number(patch.contextCount ?? session?.contextCount))
                ? Number(patch.contextCount ?? session?.contextCount)
                : 0,
            created: session?.created || "",
            frequencyPenalty: Number.isFinite(Number(patch.frequencyPenalty ?? session?.frequencyPenalty))
                ? Number(patch.frequencyPenalty ?? session?.frequencyPenalty)
                : 0,
            icon: patch.icon ?? session?.icon ?? "",
            id: Number(session?.id),
            localPlugins: patch.localPlugins ?? session?.localPlugins ?? null,
            maxToken: Number.isFinite(Number(patch.maxToken ?? session?.maxToken))
                ? Number(patch.maxToken ?? session?.maxToken)
                : 0,
            mcp: Array.isArray(patch.mcp) ? patch.mcp : Array.isArray(session?.mcp) ? session.mcp : [],
            model: String(patch.model ?? session?.model ?? "").trim(),
            name: String(patch.name ?? session?.name ?? "").trim(),
            plugins: patch.plugins ?? session?.plugins ?? null,
            presencePenalty: Number.isFinite(Number(patch.presencePenalty ?? session?.presencePenalty))
                ? Number(patch.presencePenalty ?? session?.presencePenalty)
                : 0,
            prompt: String(patch.prompt ?? session?.prompt ?? "").trim(),
            rags: Array.isArray(patch.rags) ? patch.rags : Array.isArray(session?.rags) ? session.rags : [],
            temperature: Number.isFinite(Number(patch.temperature ?? session?.temperature))
                ? Number(patch.temperature ?? session?.temperature)
                : 0.7,
            topSort: Number.isFinite(Number(patch.topSort ?? session?.topSort))
                ? Number(patch.topSort ?? session?.topSort)
                : 0,
            uid: Number(session?.uid),
            updated: session?.updated || "",
            useAppId: Number.isFinite(Number(patch.useAppId ?? session?.useAppId))
                ? Number(patch.useAppId ?? session?.useAppId)
                : 0,
        };
    }

    async updateSession(session, patch = {}) {
        const sessionId = Number(session?.id);
        if (!Number.isFinite(sessionId)) {
            throw this._buildError("AI8 session id must be numeric.", 400);
        }

        const payload = this.buildSessionUpdatePayload(session, patch);
        return this.requestJson(`/chat/session/${sessionId}`, {
            body: payload,
            method: "PUT",
        });
    }

    async streamChatCompletion(options = {}, handlers = {}) {
        const payload = {
            files: Array.isArray(options.files)
                ? options.files
                      .map(file => ({
                          data: file?.data,
                          name: file?.name,
                      }))
                      .filter(file => typeof file.data === "string" && file.data && typeof file.name === "string" && file.name)
                : [],
            sessionId: options.sessionId,
            text: options.text || "",
            thinking: Boolean(options.thinking),
        };

        if (typeof options.systemPrompt === "string" && options.systemPrompt.trim()) {
            payload.systemPrompt = options.systemPrompt.trim();
        }

        const response = await this._fetch("/chat/completions", {
            body: payload,
            method: "POST",
            signal: options.signal,
            timeoutMs: options.timeoutMs,
        });

        const contentType = String(response.headers.get("content-type") || "");
        if (!response.ok) {
            const responsePayload = await this._readUnexpectedPayload(response);
            throw this._normalizeError(responsePayload, response.status);
        }

        if (contentType.startsWith("application/json")) {
            const jsonPayload = await response.json();
            if (jsonPayload?.code !== 0) {
                throw this._normalizeError(jsonPayload, response.status);
            }

            if (typeof handlers.onObject === "function") {
                handlers.onObject(jsonPayload.data, jsonPayload);
            }

            if (typeof handlers.onDone === "function") {
                handlers.onDone();
            }

            return {
                record: jsonPayload.data || null,
                taskId: jsonPayload?.data?.taskId || null,
            };
        }

        if (contentType.startsWith("text/plain")) {
            throw this._buildError(await response.text(), response.status || 502);
        }

        if (!contentType.startsWith("text/event-stream")) {
            throw this._buildError(`Unexpected AI8 response content-type: ${contentType || "unknown"}`, 502);
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let finalRecord = null;
        let taskId = response.headers.get("x-chat-task-id") || null;
        const thinkingState = {
            mode: "answer",
            buffer: "",
            reasoning: "",
            text: "",
        };

        let readOffset = 0;

        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });

            for (;;) {
                const boundary = this._findEventBoundary(buffer, readOffset);
                if (!boundary) {
                    break;
                }

                const rawEvent = buffer.slice(readOffset, boundary.index);
                readOffset = boundary.index + boundary.length;

                const data = this._readEventData(rawEvent);
                if (!data) {
                    continue;
                }

                if (data === "[DONE]") {
                    if (typeof handlers.onDone === "function") {
                        handlers.onDone();
                    }

                    return {
                        record: finalRecord,
                        taskId,
                    };
                }

                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch (error) {
                    throw this._buildError(`Failed to parse AI8 SSE payload: ${error.message}`, 502);
                }

                if (parsed?.code !== 0) {
                    throw this._normalizeError(parsed, response.status || 502);
                }

                if (parsed?.id && !taskId) {
                    taskId = parsed.id;
                }

                if (typeof parsed?.data === "string") {
                    const split = this._splitThinkingChunk(parsed.data, thinkingState);
                    if (split.reasoning && typeof handlers.onReasoning === "function") {
                        handlers.onReasoning(split.reasoning, parsed);
                    }
                    if (split.text && typeof handlers.onText === "function") {
                        handlers.onText(split.text, parsed);
                    }
                    continue;
                }

                if (parsed?.data && typeof parsed.data === "object") {
                    finalRecord = this._normalizeThinkingRecord(parsed.data, thinkingState);
                    if (parsed.data.taskId && !taskId) {
                        taskId = parsed.data.taskId;
                    }

                    if (typeof handlers.onObject === "function") {
                        handlers.onObject(finalRecord, parsed);
                    }
                }
            }

            if (readOffset > 8192) {
                buffer = buffer.slice(readOffset);
                readOffset = 0;
            }
        }

        if (typeof handlers.onDone === "function") {
            handlers.onDone();
        }

        return {
            record: finalRecord,
            taskId,
        };
    }

    _splitThinkingChunk(chunk, state) {
        if (state.mode === "answer") {
            if (chunk.startsWith("<think>")) {
                state.mode = "reasoning";
                state.buffer = "";
                state.reasoning = "";
                state.text = "";
                return this._splitThinkingChunk(chunk.slice("<think>".length), state);
            }
            state.text += chunk;
            return { reasoning: "", text: chunk };
        }

        state.buffer += chunk;
        const marker = "</think>";
        const markerIndex = state.buffer.indexOf(marker);
        if (markerIndex !== -1) {
            const reasoningChunk = state.buffer.slice(0, markerIndex);
            const remainder = state.buffer.slice(markerIndex + marker.length);
            state.buffer = "";
            state.mode = "answer";
            state.reasoning += reasoningChunk;
            state.text = "";
            return {
                reasoning: reasoningChunk,
                text: remainder,
            };
        }

        const keep = Math.min(state.buffer.length, marker.length - 1);
        const flushable = state.buffer.slice(0, state.buffer.length - keep);
        const held = state.buffer.slice(state.buffer.length - keep);
        state.reasoning += flushable;
        state.buffer = held;
        return { reasoning: flushable, text: "" };
    }

    _normalizeThinkingRecord(record, state) {
        if (!record || typeof record !== "object") {
            return record;
        }

        const normalized = { ...record };
        if (typeof record.aiText === "string") {
            const raw = record.aiText;
            let answer = raw;
            let reasoning = "";
            if (raw.startsWith("<think>")) {
                const markerIndex = raw.indexOf("</think>");
                if (markerIndex !== -1) {
                    reasoning = raw.slice("<think>".length, markerIndex);
                    answer = raw.slice(markerIndex + "</think>".length);
                }
            }
            normalized.aiText = answer;
            if (reasoning || state.reasoning) {
                normalized.reasoning_content = reasoning || state.reasoning;
            }
        } else if (state.reasoning) {
            normalized.reasoning_content = state.reasoning;
        }

        return normalized;
    }

    async requestJson(path, options = {}) {
        const response = await this._fetch(path, options);
        const payload = await response.json().catch(async () => {
            throw this._buildError(`AI8 returned a non-JSON response for ${path}: ${await response.text()}`, 502);
        });

        if (!response.ok || payload?.code !== 0) {
            throw this._normalizeError(payload, response.status);
        }

        return payload.data;
    }

    async _fetch(path, options = {}) {
        const {
            body,
            headers = {},
            method = "GET",
            query,
            signal,
            timeoutMs = this.requestTimeoutMs,
        } = options;

        const url = new URL(path.replace(/^\/+/, ""), `${this.baseUrl}/`);
        if (query && typeof query === "object") {
            for (const [key, value] of Object.entries(query)) {
                if (value === undefined || value === null || value === "") {
                    continue;
                }

                url.searchParams.set(key, String(value));
            }
        }

        const requestHeaders = {
            Authorization: this.authToken,
            "X-APP-VERSION": this.xAppVersion,
            ...headers,
        };

        let requestBody = body;
        if (
            body &&
            typeof body === "object" &&
            !Buffer.isBuffer(body) &&
            !(body instanceof ArrayBuffer) &&
            typeof body.pipe !== "function"
        ) {
            requestBody = JSON.stringify(body);
            if (!requestHeaders["Content-Type"]) {
                requestHeaders["Content-Type"] = "application/json";
            }
        }

        const mergedSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs);

        return fetch(url, {
            body: requestBody,
            headers: requestHeaders,
            method,
            signal: mergedSignal,
        });
    }

    async _readUnexpectedPayload(response) {
        const contentType = String(response.headers.get("content-type") || "");
        if (contentType.startsWith("application/json")) {
            return response.json().catch(() => response.text());
        }

        return response.text();
    }

    _normalizeError(source, status = 500) {
        if (source instanceof Error) {
            source.status = source.status || status;
            return source;
        }

        if (typeof source === "string") {
            return this._buildError(source, status);
        }

        const message =
            source?.err ||
            source?.msg ||
            source?.message ||
            source?.error?.message ||
            `AI8 request failed with status ${status}`;

        const error = this._buildError(message, this._resolveErrorStatus(source, status, message));
        if (source?.code !== undefined) {
            error.code = source.code;
        }
        if (source && typeof source === "object") {
            error.upstream = source;
        }
        return error;
    }

    _resolveErrorStatus(source, status, message) {
        const numericStatus = Number(status);
        if (Number.isFinite(numericStatus) && numericStatus >= 400) {
            return numericStatus;
        }

        const text = String(message || "").trim().toLowerCase();
        if (!text) {
            return 502;
        }

        if (
            text.includes("授权登陆已过期") ||
            text.includes("重新登陆") ||
            text.includes("重新登录") ||
            text.includes("login expired") ||
            text.includes("token expired") ||
            text.includes("unauthorized")
        ) {
            return 401;
        }

        if (text.includes("无权限") || text.includes("forbidden") || text.includes("permission denied")) {
            return 403;
        }

        if (
            text.includes("rate limit") ||
            text.includes("too many requests") ||
            text.includes("请求过于频繁") ||
            text.includes("频率过高")
        ) {
            return 429;
        }

        if (
            text.includes("invalid") ||
            text.includes("参数") ||
            text.includes("格式") ||
            text.includes("not found") ||
            text.includes("不存在") ||
            text.includes("ambiguous")
        ) {
            return 400;
        }

        return 502;
    }

    _buildError(message, status = 500) {
        const error = new Error(message);
        error.status = status;
        return error;
    }

    _findEventBoundary(buffer, fromIndex = 0) {
        // Prefer indexOf over a full-buffer regex to avoid O(n^2) rescanning on
        // long streams. Find the earliest of \n\n and \r\n\r\n.
        const lfIndex = buffer.indexOf("\n\n", fromIndex);
        const crlfIndex = buffer.indexOf("\r\n\r\n", fromIndex);

        if (lfIndex === -1) {
            if (crlfIndex === -1) {
                return null;
            }
            return { index: crlfIndex, length: 4 };
        }

        if (crlfIndex === -1) {
            return { index: lfIndex, length: 2 };
        }

        return lfIndex <= crlfIndex
            ? { index: lfIndex, length: 2 }
            : { index: crlfIndex, length: 4 };
    }

    _readEventData(rawEvent) {
        const lines = rawEvent.split(/\r?\n/);
        const dataLines = [];

        for (const line of lines) {
            if (!line.startsWith("data:")) {
                continue;
            }

            dataLines.push(line.slice(5).trimStart());
        }

        return dataLines.join("\n");
    }
}

module.exports = AI8Client;
module.exports.AI8_DRAW_MODELS = AI8_DRAW_MODELS;
module.exports.resolveDrawModel = resolveDrawModel;
module.exports.sizeToAspectRatio = sizeToAspectRatio;
module.exports.parseDrawVersionsFromChunk = parseDrawVersionsFromChunk;
module.exports.classifyDrawProvider = classifyDrawProvider;
