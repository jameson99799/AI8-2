#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const {
    GEMINI_SHARE_URL_GLOBAL_PATTERN,
    SHARE_LINK_CONFIG_PATH,
    isGeminiShareUrl,
    loadGeminiShareUrl,
} = require("../src/utils/ShareLink");

const nextUrl = process.argv[2]?.trim();

if (nextUrl && !isGeminiShareUrl(nextUrl)) {
    console.error("Invalid Gemini share URL. Expected format: https://gemini.google.com/share/<id>");
    process.exit(1);
}

if (nextUrl) {
    fs.writeFileSync(SHARE_LINK_CONFIG_PATH, `${JSON.stringify({ geminiShareUrl: nextUrl }, null, 4)}\n`, "utf-8");
}

const shareUrl = loadGeminiShareUrl();

if (!shareUrl) {
    console.error(`No Gemini share URL configured. Set one in ${SHARE_LINK_CONFIG_PATH} or pass it as an argument.`);
    process.exit(1);
}

const targets = [".env.example", "README.md", "README_EN.md"];

const updatedFiles = [];

for (const relativePath of targets) {
    const absolutePath = path.join(process.cwd(), relativePath);
    const original = fs.readFileSync(absolutePath, "utf-8");
    const updated = original.replace(GEMINI_SHARE_URL_GLOBAL_PATTERN, shareUrl);

    if (updated !== original) {
        fs.writeFileSync(absolutePath, updated, "utf-8");
        updatedFiles.push(relativePath);
    }
}

console.log(`Gemini share URL: ${shareUrl}`);
if (updatedFiles.length > 0) {
    console.log(`Updated files: ${updatedFiles.join(", ")}`);
} else {
    console.log("No documentation changes were needed.");
}
