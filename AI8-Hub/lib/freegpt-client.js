"use strict";

const crypto = require("crypto");
const { generateSecurePayload } = require("./freegpt-wasm");

const DEFAULT_BASE_URL = "https://chat1.freegpt.work";
const CHALLENGE_TTL_SAFETY_MS = 30 * 1000;

class FreeGptClient {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.uuid = String(options.uuid || "").trim();
        this.clientIp = String(options.clientIp || "").trim();
        this.defaultModel = String(options.defaultModel || "").trim();
        this.requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
            ? Number(options.requestTimeoutMs)
            : 300000;
        this.modelCacheTtlMs = Number.isFinite(Number(options.modelCacheTtlMs))
            ? Number(options.modelCacheTtlMs)
            : 300000;
        this.challengeCache = {
            data: null,
            expiresAt: 0,
        };
        this.modelCache = {
            data: null,
            expiresAt: 0,
        };

        if (!this.uuid) {
            throw new Error("FREEGPT_UUID is required.");
        }
    }

    _resolveOrigin() {
        try {
            return new URL(this.baseUrl).origin;
        } catch (error) {
            return DEFAULT_BASE_URL;
        }
    }

    async fetchModels({ forceRefresh = false } = {}) {
        const now = Date.now();
        if (!forceRefresh && this.modelCache.data && now < this.modelCache.expiresAt) {
            return this.modelCache.data;
        }

        const data = await this.requestJson("/api/openai/oneapi/v1/models", { cache: "no-store" });
        const models = this._flattenModels(data);
        this.modelCache = {
            data: models,
            expiresAt: now + this.modelCacheTtlMs,
        };
        return models;
    }

    _flattenModels(data = []) {
        if (!Array.isArray(data)) {
            return [];
        }
        const models = [];
        for (const item of data) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const id = String(item.id || item.name || "").trim();
            if (!id || item.available === false) {
                continue;
            }
            models.push({
                ...item,
                label: String(item.name || item.id || ""),
                value: id,
            });
        }
        return models;
    }

    async resolveModel(model) {
        const requested = String(model || this.defaultModel || "").trim();
        if (!requested) {
            throw this._buildError("freegpt model name is required.", 400);
        }

        const models = await this.fetchModels();
        const normalizedRequested = requested.toLowerCase();

        const exactMatch = models.find(item => String(item.value || "").toLowerCase() === normalizedRequested);
        if (exactMatch) {
            return exactMatch;
        }

        const shortMatches = models.filter(item => {
            const shortName = String(item.value || "").split("/").pop();
            return shortName && shortName.toLowerCase() === normalizedRequested;
        });

        if (shortMatches.length === 1) {
            return shortMatches[0];
        }

        if (shortMatches.length > 1) {
            throw this._buildError(`Model "${requested}" is ambiguous on freegpt. Use the full model id instead.`, 400);
        }

        throw this._buildError(`Model "${requested}" was not found on freegpt.`, 400);
    }

    async _getChallenge({ forceRefresh = false } = {}) {
        const now = Date.now();
        if (!forceRefresh && this.challengeCache.data && now < this.challengeCache.expiresAt) {
            return this.challengeCache.data;
        }

        const data = await this.requestJson("/api/challenge", { cache: "no-store" });
        if (
            !data ||
            typeof data.challengeId !== "string" ||
            typeof data.challenge !== "string" ||
            !Number.isFinite(Number(data.difficulty))
        ) {
            throw this._buildError("freegpt returned an invalid challenge.", 502);
        }

        this.challengeCache = {
            data,
            expiresAt: Number(data.expiresAt) - CHALLENGE_TTL_SAFETY_MS,
        };
        return data;
    }

    async buildSecureHeaders() {
        const challenge = await this._getChallenge({ forceRefresh: true });
        const timestamp = Date.now().toString();
        const nonce = crypto.randomUUID();

        const payload = await generateSecurePayload(
            this.uuid,
            timestamp,
            nonce,
            challenge.challenge,
            this.clientIp || "127.0.0.1",
            Number(challenge.difficulty) || 2
        );

        if (!payload || typeof payload.signature !== "string" || typeof payload.fingerprint !== "string") {
            throw this._buildError("freegpt secure payload generation failed.", 502);
        }

        return {
            "x-secure-challenge-id": String(challenge.challengeId),
            "x-secure-challenge-expires-at": String(challenge.expiresAt),
            "x-secure-challenge-version": String(challenge.version || "1.0"),
            "x-secure-signature": payload.signature,
            "x-secure-fingerprint": payload.fingerprint,
            "x-secure-client-ip": String(payload.client_ip || this.clientIp || "127.0.0.1"),
            "x-secure-pow-seed-nonce": String(payload.pow?.seed_nonce ?? ""),
            "x-secure-pow-nonce": String(payload.pow?.nonce ?? ""),
            "x-secure-pow-hash": String(payload.pow?.hash ?? ""),
            "x-secure-pow-difficulty": String(payload.pow?.difficulty ?? challenge.difficulty),
            "x-secure-timestamp": timestamp,
            "x-secure-nonce": nonce,
            "x-secure-version": String(payload.v || "3.0"),
        };
    }

    async streamChatCompletion(options = {}, handlers = {}) {
        const model = await this.resolveModel(options.model);
        const messages = Array.isArray(options.messages) && options.messages.length > 0
            ? options.messages
            : [{ role: "user", content: options.text || "" }];

        const payload = {
            messages,
            stream: true,
            model: model.value,
            temperature: 0.5,
            presence_penalty: 0,
            frequency_penalty: 0,
            top_p: 1,
        };
        if (Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0) {
            payload.max_tokens = Number(options.maxTokens);
        }

        const secureHeaders = await this.buildSecureHeaders();
        let response = await this._fetch("/api/openai/oneapi/v1/chat/completions", {
            body: payload,
            method: "POST",
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            extraHeaders: secureHeaders,
        });

        if (!response.ok) {
            const responsePayload = await this._readUnexpectedPayload(response);
            const errorMessage = String(
                responsePayload?.error?.message || responsePayload?.message || ""
            ).toLowerCase();
            const secureHint = /signature|challenge|fingerprint|pow|nonce|expired|timestamp/.test(errorMessage);
            if ((response.status === 401 || response.status === 403) && secureHint) {
                await this._getChallenge({ forceRefresh: true });
                const retryHeaders = await this.buildSecureHeaders();
                response = await this._fetch("/api/openai/oneapi/v1/chat/completions", {
                    body: payload,
                    method: "POST",
                    signal: options.signal,
                    timeoutMs: options.timeoutMs,
                    extraHeaders: retryHeaders,
                });
                if (!response.ok) {
                    const retryPayload = await this._readUnexpectedPayload(response);
                    throw this._normalizeError(retryPayload, response.status);
                }
            } else {
                throw this._normalizeError(responsePayload, response.status);
            }
        }

        const contentType = String(response.headers.get("content-type") || "");
        if (contentType.startsWith("application/json")) {
            const jsonPayload = await response.json();
            if (jsonPayload && typeof jsonPayload === "object" && jsonPayload.error) {
                throw this._normalizeError(jsonPayload, response.status || 502);
            }
            if (typeof handlers.onObject === "function") {
                handlers.onObject(jsonPayload);
            }
            if (typeof handlers.onDone === "function") {
                handlers.onDone();
            }
            return { record: jsonPayload };
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let usage = null;
        let readOffset = 0;

        const processSseLine = rawLine => {
            const line = rawLine.trim();
            if (!line || !line.startsWith("data:")) {
                return;
            }
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(data);
            } catch (error) {
                if (typeof handlers.onError === "function") {
                    handlers.onError(error, rawLine);
                }
                return;
            }
            const delta = parsed?.choices?.[0]?.delta?.content;
            const finishReason = parsed?.choices?.[0]?.finish_reason;
            if (parsed?.error || (finishReason === "error" && !delta)) {
                const upstreamMessage = String(parsed?.error?.message || parsed?.error || "").trim();
                throw this._buildError(upstreamMessage || "freegpt stream ended with an error.", 502);
            }
            if (typeof delta === "string" && delta) {
                content += delta;
                if (typeof handlers.onText === "function") {
                    handlers.onText(delta, parsed);
                }
            }
            if (parsed?.usage && typeof parsed.usage === "object") {
                usage = parsed.usage;
            }
            if (typeof handlers.onObject === "function") {
                handlers.onObject(parsed);
            }
        };

        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            for (;;) {
                const index = buffer.indexOf("\n", readOffset);
                if (index === -1) {
                    break;
                }
                const newlineLength = index > 0 && buffer[index - 1] === "\r" ? 2 : 1;
                const rawLine = buffer.slice(readOffset, index + (newlineLength === 2 ? -1 : 0));
                readOffset = index + newlineLength;
                processSseLine(rawLine);
            }
            if (readOffset > 8192) {
                buffer = buffer.slice(readOffset);
                readOffset = 0;
            }
        }

        if (buffer.slice(readOffset).trim()) {
            processSseLine(buffer.slice(readOffset).trim());
        }

        if (typeof handlers.onDone === "function") {
            handlers.onDone();
        }

        return {
            content,
            record: {
                content,
                ...(usage ? { useTokens: Number(usage.total_tokens) || 0 } : {}),
            },
        };
    }

    async requestJson(path, options = {}) {
        const response = await this._fetch(path, options);
        const text = await response.text();
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            throw this._buildError(`freegpt returned a non-JSON response for ${path}: ${text}`, 502);
        }

        if (!response.ok) {
            throw this._normalizeError(payload || text, response.status);
        }

        if (payload && typeof payload === "object" && payload.success === false && payload.message) {
            throw this._normalizeError(payload, response.status);
        }

        return payload?.data ?? payload;
    }

    async _fetch(path, options = {}) {
        const {
            body,
            headers = {},
            method = "GET",
            query,
            signal,
            timeoutMs = this.requestTimeoutMs,
            extraHeaders = {},
            cache,
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

        const origin = this._resolveOrigin();
        const requestHeaders = {
            accept: "application/json, text/event-stream",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
            "cache-control": "no-cache",
            origin,
            pragma: "no-cache",
            referer: `${origin}/`,
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0",
            uuid: this.uuid,
            "x-origin": origin,
            ...headers,
            ...extraHeaders,
        };
        if (cache) {
            requestHeaders["cache-control"] = cache;
        }

        let requestBody = body;
        if (body && typeof body === "object" && !Buffer.isBuffer(body) && typeof body.pipe !== "function") {
            requestBody = JSON.stringify(body);
        }
        if (requestBody && !headers["content-type"] && !extraHeaders["content-type"]) {
            requestHeaders["content-type"] = "application/json";
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
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch (error) {
            return text;
        }
    }

    _normalizeError(source, status = 500) {
        if (source instanceof Error) {
            source.status = source.status || status;
            return source;
        }

        let message = "";
        if (typeof source === "string") {
            message = source;
        } else if (source && typeof source === "object") {
            message =
                source.error?.message ||
                source.message ||
                source.err ||
                source.msg ||
                `freegpt request failed with status ${status}`;
        }

        const resolvedStatus = this._resolveErrorStatus(source || message, status, message);
        const error = this._buildError(message || "freegpt request failed.", resolvedStatus);
        if (source && typeof source === "object") {
            if (source.error?.code !== undefined) {
                error.code = source.error.code;
            }
            error.upstream = source;
        }
        return error;
    }

    _resolveErrorStatus(source, status, message) {
        const numericStatus = Number(status);
        if (Number.isFinite(numericStatus) && numericStatus >= 400 && numericStatus < 600) {
            return numericStatus;
        }

        const text = String(message || "").trim().toLowerCase();
        if (!text) {
            return 502;
        }

        if (
            text.includes("授权") ||
            text.includes("登录") ||
            text.includes("鉴权") ||
            text.includes("token") ||
            text.includes("key") ||
            text.includes("unauthorized") ||
            text.includes("invalid")
        ) {
            return 401;
        }

        if (
            text.includes("额度") ||
            text.includes("次数") ||
            text.includes("quota") ||
            text.includes("rate limit") ||
            text.includes("exhausted")
        ) {
            return 429;
        }

        return 502;
    }

    _buildError(message, status = 500) {
        const error = new Error(message);
        error.status = status;
        return error;
    }
}

module.exports = FreeGptClient;
