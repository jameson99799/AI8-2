const fs = require("fs");
const path = require("path");

const GEMINI_SHARE_URL_PATTERN = /^https:\/\/gemini\.google\.com\/share\/[\w-]+$/;
const GEMINI_SHARE_URL_GLOBAL_PATTERN = /https:\/\/gemini\.google\.com\/share\/[\w-]+/g;
const SHARE_LINK_CONFIG_PATH = path.join(process.cwd(), "configs", "share-link.json");

function isGeminiShareUrl(value) {
    return GEMINI_SHARE_URL_PATTERN.test(String(value || "").trim());
}

function loadGeminiShareUrl(logger) {
    try {
        if (!fs.existsSync(SHARE_LINK_CONFIG_PATH)) {
            return "";
        }

        const raw = fs.readFileSync(SHARE_LINK_CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        const configuredUrl = parsed?.geminiShareUrl;

        if (isGeminiShareUrl(configuredUrl)) {
            return configuredUrl.trim();
        }

        if (configuredUrl) {
            logger?.warn?.(
                `[Config] Invalid geminiShareUrl in ${path.relative(process.cwd(), SHARE_LINK_CONFIG_PATH)}.`
            );
        }
    } catch (error) {
        logger?.warn?.(
            `[Config] Failed to read ${path.relative(process.cwd(), SHARE_LINK_CONFIG_PATH)}: ${error.message}`
        );
    }

    return "";
}

module.exports = {
    GEMINI_SHARE_URL_GLOBAL_PATTERN,
    isGeminiShareUrl,
    loadGeminiShareUrl,
    SHARE_LINK_CONFIG_PATH,
};
