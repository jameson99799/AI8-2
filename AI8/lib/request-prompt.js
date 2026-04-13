"use strict";

function resolveSessionPrompt(body, preparedMessages) {
    const directCandidates = [
        {
            source: "metadata.ai8_session_prompt",
            value: body?.metadata?.ai8_session_prompt,
        },
        {
            source: "metadata.session_prompt",
            value: body?.metadata?.session_prompt,
        },
        {
            source: "metadata.prompt",
            value: body?.metadata?.prompt,
        },
        {
            source: "instructions",
            value: body?.instructions,
        },
        {
            source: "prompt",
            value: body?.prompt,
        },
    ];

    for (const candidate of directCandidates) {
        const normalized = normalizePrompt(candidate.value);
        if (normalized) {
            return {
                source: candidate.source,
                value: normalized,
            };
        }
    }

    return {
        source: "messages.system_or_developer",
        value: normalizePrompt(preparedMessages?.systemPrompt),
    };
}

function normalizePrompt(value) {
    if (typeof value !== "string") {
        return "";
    }

    const text = value.trim();
    return text || "";
}

module.exports = {
    resolveSessionPrompt,
};
