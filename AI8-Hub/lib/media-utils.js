"use strict";

const dns = require("dns");
const net = require("net");
const path = require("path");

const DEFAULT_MAX_REMOTE_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const MIME_EXTENSION_MAP = {
    "application/json": ".json",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "text/csv": ".csv",
    "text/markdown": ".md",
    "text/plain": ".txt",
};

function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeUrlLikeValue(value) {
    if (typeof value === "string") {
        return value.trim();
    }

    if (!value || typeof value !== "object") {
        return "";
    }

    return normalizeString(value.url || value.data || value.value);
}

function extractMimeTypeFromDataUrl(dataUrl) {
    const match = normalizeString(dataUrl).match(/^data:([^;,]+);base64,/i);
    return match ? match[1].toLowerCase() : "";
}

function guessExtensionFromUrl(url) {
    try {
        const parsed = new URL(url);
        const extension = path.extname(parsed.pathname || "").toLowerCase();
        return extension || "";
    } catch (error) {
        return "";
    }
}

function guessExtensionFromMimeType(mimeType) {
    return MIME_EXTENSION_MAP[String(mimeType || "").toLowerCase()] || "";
}

function sanitizeFileName(name) {
    return String(name || "")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
}

function ensureFileName(name, mimeType, url, prefix = "upload") {
    let finalName = sanitizeFileName(name);
    const inferredExtension =
        guessExtensionFromUrl(url) || guessExtensionFromMimeType(mimeType) || ".bin";

    if (!finalName) {
        finalName = `${prefix}${inferredExtension}`;
    } else if (!path.extname(finalName) && inferredExtension) {
        finalName += inferredExtension;
    }

    return finalName;
}

function buildDataUrl(mimeType, base64) {
    const normalizedMimeType = normalizeString(mimeType) || "application/octet-stream";
    const normalizedBase64 = normalizeString(base64);

    if (!normalizedBase64) {
        return "";
    }

    return `data:${normalizedMimeType};base64,${normalizedBase64}`;
}

function isPrivateAddress(address) {
    const normalized = String(address || "").trim().toLowerCase();
    if (!normalized) {
        return true;
    }

    // IPv4-mapped IPv6 form (::ffff:127.0.0.1)
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    const candidate = mapped ? mapped[1] : normalized;

    if (net.isIP(candidate) === 4) {
        const [a, b] = candidate.split(".").map(Number);
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true; // link-local + cloud metadata
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        if (a >= 224) return true; // multicast / reserved
        return false;
    }

    if (net.isIP(candidate) === 6) {
        if (candidate === "::" || candidate === "::1") return true;
        if (candidate.startsWith("fc") || candidate.startsWith("fd")) return true; // unique local
        if (candidate.startsWith("fe80")) return true; // link-local
        if (candidate.startsWith("ff")) return true; // multicast
        return false;
    }

    return false;
}

/**
 * Reject URLs that point at loopback/private/link-local addresses so a client
 * (or model output) cannot make the server fetch internal resources.
 */
async function assertSafeRemoteUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (error) {
        throw new Error(`Invalid URL: ${url}`);
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
        throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname) {
        throw new Error("URL hostname is empty.");
    }
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
        throw new Error(`Refusing to fetch local address: ${hostname}`);
    }

    if (net.isIP(hostname)) {
        if (isPrivateAddress(hostname)) {
            throw new Error(`Refusing to fetch private address: ${hostname}`);
        }
        return;
    }

    const records = await dns.promises.lookup(hostname, { all: true }).catch(() => []);
    if (records.length === 0) {
        throw new Error(`Failed to resolve host: ${hostname}`);
    }

    for (const record of records) {
        if (isPrivateAddress(record.address)) {
            throw new Error(`Refusing to fetch private address: ${hostname} -> ${record.address}`);
        }
    }
}

async function readBodyWithLimit(response, maxBytes) {
    if (!response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) {
            throw new Error(`Remote file exceeds the ${maxBytes} byte limit.`);
        }
        return buffer;
    }

    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            total += value.length;
            if (total > maxBytes) {
                throw new Error(`Remote file exceeds the ${maxBytes} byte limit.`);
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        try {
            await reader.cancel();
        } catch (cancelError) {
            // Reader may already be closed.
        }
        reader.releaseLock();
    }

    return Buffer.concat(chunks);
}

async function fetchUrlAsDataUrl(url, options = {}) {
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 60000;
    const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Number(options.maxBytes) : DEFAULT_MAX_REMOTE_BYTES;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
        let currentUrl = url;
        let response = null;

        for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
            await assertSafeRemoteUrl(currentUrl);
            response = await fetch(currentUrl, {
                signal: abortController.signal,
                redirect: "manual",
            });

            if (REDIRECT_STATUSES.has(response.status)) {
                const location = response.headers.get("location");
                if (!location) {
                    break;
                }
                currentUrl = new URL(location, currentUrl).toString();
                continue;
            }

            break;
        }

        if (!response || !response.ok) {
            throw new Error(`Failed to fetch "${url}" (${response ? response.status : "no response"}).`);
        }

        const mimeType = String(response.headers.get("content-type") || "application/octet-stream")
            .split(";")[0]
            .trim()
            .toLowerCase();

        const buffer = await readBodyWithLimit(response, maxBytes);
        const base64 = buffer.toString("base64");

        return {
            data: buildDataUrl(mimeType, base64),
            name: ensureFileName(options.name, mimeType, url, options.prefix || "upload"),
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function normalizeAi8FileInput(options = {}) {
    const data = normalizeString(options.data);
    const url = normalizeString(options.url);
    const mimeType = normalizeString(options.mimeType);

    if (data) {
        if (data.startsWith("data:")) {
            const dataMimeType = extractMimeTypeFromDataUrl(data);
            return {
                data,
                name: ensureFileName(options.name, dataMimeType || mimeType, null, options.prefix),
            };
        }

        return {
            data: buildDataUrl(mimeType, data),
            name: ensureFileName(options.name, mimeType, null, options.prefix),
        };
    }

    if (!url) {
        throw new Error("A file input must include either data or a URL.");
    }

    if (url.startsWith("data:")) {
        const dataMimeType = extractMimeTypeFromDataUrl(url);
        return {
            data: url,
            name: ensureFileName(options.name, dataMimeType || mimeType, null, options.prefix),
        };
    }

    if (/^https?:\/\//i.test(url)) {
        return fetchUrlAsDataUrl(url, options);
    }

    return {
        data: buildDataUrl(mimeType, url),
        name: ensureFileName(options.name, mimeType, null, options.prefix),
    };
}

async function contentPartToAi8File(part, options = {}) {
    const messageIndex = Number.isFinite(Number(options.messageIndex)) ? Number(options.messageIndex) : 0;
    const partIndex = Number.isFinite(Number(options.partIndex)) ? Number(options.partIndex) : 0;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 60000;

    if (!part || typeof part !== "object") {
        throw new Error("The content part must be an object.");
    }

    switch (part.type) {
        case "image_url":
        case "input_image": {
            const source = normalizeUrlLikeValue(part.image_url || part.input_image || part.url || part.data);
            if (!source) {
                throw new Error("The image content part does not contain a usable URL or data payload.");
            }

            const mimeType =
                normalizeString(part.mime_type) ||
                extractMimeTypeFromDataUrl(source) ||
                "image/png";

            return normalizeAi8FileInput({
                data: /^data:/i.test(source) ? source : "",
                mimeType,
                name: part.filename || part.name || `image-${messageIndex + 1}-${partIndex + 1}`,
                prefix: "image",
                timeoutMs,
                url: /^https?:\/\//i.test(source) ? source : "",
            });
        }
        case "input_file": {
            return normalizeAi8FileInput({
                data: normalizeUrlLikeValue(part.file_data || part.data),
                mimeType:
                    normalizeString(part.mime_type) ||
                    extractMimeTypeFromDataUrl(part.file_data || part.data),
                name: part.filename || part.name || `file-${messageIndex + 1}-${partIndex + 1}`,
                prefix: "file",
                timeoutMs,
                url: normalizeUrlLikeValue(part.file_url || part.url),
            });
        }
        default:
            throw new Error(`Unsupported content part type: ${part.type || "unknown"}`);
    }
}

function extractAi8Images(text) {
    const content = typeof text === "string" ? text : "";
    const images = [];
    const markdownImageRegex = /!\[([^\]]*)\]\((data:image\/[^)]+|https?:\/\/[^)\s]+)\)/gi;

    let match;
    while ((match = markdownImageRegex.exec(content)) !== null) {
        images.push({
            alt: match[1] || "",
            mime_type: extractMimeTypeFromDataUrl(match[2]) || null,
            url: match[2],
        });
    }

    return images;
}

function isProbablyImageFile(file = {}) {
    if (extractMimeTypeFromDataUrl(file.data || "")) {
        return true;
    }

    const extension = path.extname(String(file.name || "")).toLowerCase();
    return [".gif", ".jpeg", ".jpg", ".png", ".webp"].includes(extension);
}

module.exports = {
    assertSafeRemoteUrl,
    contentPartToAi8File,
    ensureFileName,
    extractAi8Images,
    extractMimeTypeFromDataUrl,
    fetchUrlAsDataUrl,
    isProbablyImageFile,
    isPrivateAddress,
    normalizeAi8FileInput,
    normalizeUrlLikeValue,
    readBodyWithLimit,
};
