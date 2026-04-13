"use strict";

const path = require("path");

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

async function fetchUrlAsDataUrl(url, options = {}) {
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 60000;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: abortController.signal,
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch "${url}" (${response.status}).`);
        }

        const mimeType = String(response.headers.get("content-type") || "application/octet-stream")
            .split(";")[0]
            .trim()
            .toLowerCase();

        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");

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
    contentPartToAi8File,
    ensureFileName,
    extractAi8Images,
    extractMimeTypeFromDataUrl,
    isProbablyImageFile,
    normalizeAi8FileInput,
    normalizeUrlLikeValue,
};
