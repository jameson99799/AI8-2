const state = {
    adminToken: window.localStorage.getItem("ai8_admin_token") || "",
    config: null,
    runtime: null,
};

const DEFAULT_ADMIN_TOKEN = "ai8-admin-local";

const elements = {
    adminModeValue: document.getElementById("adminModeValue"),
    adminTokenConfig: document.getElementById("adminTokenConfig"),
    adminTokenInput: document.getElementById("adminTokenInput"),
    ai8AuthToken: document.getElementById("ai8AuthToken"),
    ai8BaseUrl: document.getElementById("ai8BaseUrl"),
    ai8DefaultModel: document.getElementById("ai8DefaultModel"),
    ai8DefaultThinking: document.getElementById("ai8DefaultThinking"),
    ai8DeleteSessionAfterResponse: document.getElementById("ai8DeleteSessionAfterResponse"),
    ai8RequestTimeoutMs: document.getElementById("ai8RequestTimeoutMs"),
    ai8ReuseSessionInjectSystemPrompt: document.getElementById("ai8ReuseSessionInjectSystemPrompt"),
    ai8SharedSessionId: document.getElementById("ai8SharedSessionId"),
    ai8UseSharedSession: document.getElementById("ai8UseSharedSession"),
    ai8XAppVersion: document.getElementById("ai8XAppVersion"),
    apiKeys: document.getElementById("apiKeys"),
    configForm: document.getElementById("configForm"),
    exampleOutput: document.getElementById("exampleOutput"),
    loginForm: document.getElementById("loginForm"),
    logsOutput: document.getElementById("logsOutput"),
    logoutButton: document.getElementById("logoutButton"),
    mediaFetchTimeoutMs: document.getElementById("mediaFetchTimeoutMs"),
    modelsList: document.getElementById("modelsList"),
    modelsMeta: document.getElementById("modelsMeta"),
    openaiBaseValue: document.getElementById("openaiBaseValue"),
    publicBaseUrl: document.getElementById("publicBaseUrl"),
    refreshLogsButton: document.getElementById("refreshLogsButton"),
    refreshModelsButton: document.getElementById("refreshModelsButton"),
    reloadButton: document.getElementById("reloadButton"),
    requestBodyLimit: document.getElementById("requestBodyLimit"),
    runtimeGrid: document.getElementById("runtimeGrid"),
    saveConfigButton: document.getElementById("saveConfigButton"),
    statusBanner: document.getElementById("statusBanner"),
    testButton: document.getElementById("testButton"),
};

wireEvents();
bootstrap();

function wireEvents() {
    elements.loginForm.addEventListener("submit", async event => {
        event.preventDefault();
        state.adminToken = elements.adminTokenInput.value.trim();
        window.localStorage.setItem("ai8_admin_token", state.adminToken);
        await loadConsole();
    });

    elements.reloadButton.addEventListener("click", async () => {
        await loadConsole();
    });

    elements.logoutButton.addEventListener("click", () => {
        state.adminToken = "";
        state.config = null;
        state.runtime = null;
        window.localStorage.removeItem("ai8_admin_token");
        elements.adminTokenInput.value = "";
        setStatus("已清除后台登录令牌。", "success");
        resetRuntimePanels();
    });

    elements.saveConfigButton.addEventListener("click", async () => {
        await saveConfig();
    });

    elements.refreshModelsButton.addEventListener("click", async () => {
        await loadModels(true);
    });

    elements.refreshLogsButton.addEventListener("click", async () => {
        await loadLogs();
    });

    elements.testButton.addEventListener("click", async () => {
        await testUpstream();
    });
}

async function bootstrap() {
    if (!state.adminToken) {
        state.adminToken = DEFAULT_ADMIN_TOKEN;
    }

    elements.adminTokenInput.value = state.adminToken;
    if (state.adminToken) {
        await loadConsole();
        return;
    }

    resetRuntimePanels();
}

async function loadConsole() {
    if (!state.adminToken) {
        setStatus("请先输入后台令牌。", "error");
        return;
    }

    setStatus("正在加载运行状态、配置、模型和日志...");

    try {
        const [runtime, config] = await Promise.all([
            requestJson("/admin/api/runtime"),
            requestJson("/admin/api/config"),
        ]);

        state.runtime = runtime;
        state.config = config.config || null;

        renderRuntime(runtime);
        renderConfig(config.config || {});
        renderExample();

        await Promise.allSettled([
            loadModels(false),
            loadLogs(),
        ]);

        setStatus("后台已加载完成。", "success");
    } catch (error) {
        setStatus(error.message, "error");
        resetRuntimePanels();
    }
}

async function saveConfig() {
    try {
        setStatus("正在保存运行时配置...");
        const payload = {
            adminToken: elements.adminTokenConfig.value.trim(),
            ai8AuthToken: elements.ai8AuthToken.value.trim(),
            ai8BaseUrl: elements.ai8BaseUrl.value.trim(),
            ai8DefaultModel: elements.ai8DefaultModel.value.trim(),
            ai8DefaultThinking: elements.ai8DefaultThinking.checked,
            ai8DeleteSessionAfterResponse: elements.ai8DeleteSessionAfterResponse.checked,
            ai8RequestTimeoutMs: toNumberString(elements.ai8RequestTimeoutMs.value),
            ai8ReuseSessionInjectSystemPrompt: elements.ai8ReuseSessionInjectSystemPrompt.checked,
            ai8SharedSessionId: toNumberString(elements.ai8SharedSessionId.value),
            ai8UseSharedSession: elements.ai8UseSharedSession.checked,
            ai8XAppVersion: elements.ai8XAppVersion.value.trim(),
            apiKeys: elements.apiKeys.value.trim(),
            mediaFetchTimeoutMs: toNumberString(elements.mediaFetchTimeoutMs.value),
            publicBaseUrl: elements.publicBaseUrl.value.trim(),
            requestBodyLimit: elements.requestBodyLimit.value.trim(),
        };

        const response = await requestJson("/admin/api/config", {
            body: JSON.stringify(payload),
            headers: {
                "Content-Type": "application/json",
            },
            method: "PUT",
        });

        state.config = response.config || payload;
        renderConfig(state.config);
        renderExample();

        if (!response.token_still_valid) {
            setStatus("配置已保存，但当前后台令牌已失效，请使用新的后台令牌重新登录。", "error");
            return;
        }

        await Promise.allSettled([
            loadModels(false),
            loadLogs(),
            loadRuntimeOnly(),
        ]);

        setStatus("运行时配置已保存。", "success");
    } catch (error) {
        setStatus(error.message, "error");
    }
}

async function loadRuntimeOnly() {
    const runtime = await requestJson("/admin/api/runtime");
    state.runtime = runtime;
    renderRuntime(runtime);
    renderExample();
}

async function loadModels(forceRefresh) {
    try {
        const suffix = forceRefresh ? "?refresh=true" : "";
        const payload = await requestJson(`/admin/api/models${suffix}`);
        const models = Array.isArray(payload.data) ? payload.data : [];
        elements.modelsMeta.textContent = `已加载 ${models.length} 个模型，当前默认模型：${payload.default_model || "-"}`;
        elements.modelsList.innerHTML = models
            .map(model => {
                const value = escapeHtml(model.display_value || model.value || "");
                const provider = escapeHtml(model?.attr?.providerName || "ai8");
                return `<span class="tag">${value}<small>${provider}</small></span>`;
            })
            .join("");
    } catch (error) {
        elements.modelsMeta.textContent = error.message;
        elements.modelsList.innerHTML = "";
    }
}

async function loadLogs() {
    try {
        const payload = await requestJson("/admin/api/logs?limit=200");
        const lines = Array.isArray(payload.tail_lines) ? payload.tail_lines : [];
        elements.logsOutput.textContent = lines.length > 0 ? lines.join("\n") : "当前还没有日志。";
    } catch (error) {
        elements.logsOutput.textContent = error.message;
    }
}

async function testUpstream() {
    try {
        setStatus("正在测试 AI8 上游连通性...");
        const payload = await requestJson("/admin/api/test-upstream", {
            method: "POST",
        });

        const resolved = payload.resolved_default_model || payload.resolved_default_model_error || "unknown";
        setStatus(`AI8 上游连接正常，检测到 ${payload.model_count} 个模型，默认模型解析结果：${resolved}。`, "success");
    } catch (error) {
        setStatus(error.message, "error");
    }
}

function renderRuntime(runtime) {
    const auth = runtime.auth || {};
    const config = runtime.config || {};
    const network = runtime.network || {};
    const paths = runtime.paths || {};

    elements.adminModeValue.textContent = auth.admin_mode || "unknown";
    elements.openaiBaseValue.textContent = network.openai_base_url || "-";

    const entries = [
        ["OpenAI 接口地址", network.openai_base_url || "-"],
        ["优先访问地址", network.preferred_base_url || "-"],
        ["AI8 上游地址", config.ai8_base_url || "-"],
        ["默认模型", config.ai8_default_model || "-"],
        ["返回后自动删会话", config.ai8_delete_session_after_response ? "是" : "否"],
        ["启用共享会话", config.ai8_use_shared_session ? "是" : "否"],
        ["共享会话时注入提示词", config.ai8_reuse_session_inject_system_prompt ? "是" : "否"],
        ["固定复用会话", config.ai8_shared_session_id || "-"],
        ["后台鉴权模式", auth.admin_mode || "-"],
        ["本地 API 密钥数量", String(auth.api_key_count || 0)],
        ["AI8 已配置", auth.upstream_ready ? "是" : "否"],
        ["配置文件", paths.config_store || "-"],
        ["日志文件", paths.log_file || "-"],
        ["本机 IPv4 地址", (network.ipv4_candidates || []).join(", ") || "-"],
    ];

    elements.runtimeGrid.innerHTML = entries
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join("");
}

function renderConfig(config) {
    elements.adminTokenConfig.value = config.adminToken || "";
    elements.ai8AuthToken.value = config.ai8AuthToken || "";
    elements.ai8BaseUrl.value = config.ai8BaseUrl || "";
    elements.ai8DefaultModel.value = config.ai8DefaultModel || "";
    elements.ai8DefaultThinking.checked = Boolean(config.ai8DefaultThinking);
    elements.ai8DeleteSessionAfterResponse.checked = Boolean(config.ai8DeleteSessionAfterResponse);
    elements.ai8RequestTimeoutMs.value = config.ai8RequestTimeoutMs || "";
    elements.ai8ReuseSessionInjectSystemPrompt.checked = Boolean(config.ai8ReuseSessionInjectSystemPrompt);
    elements.ai8SharedSessionId.value = config.ai8SharedSessionId || "";
    elements.ai8UseSharedSession.checked = Boolean(config.ai8UseSharedSession);
    elements.ai8XAppVersion.value = config.ai8XAppVersion || "";
    elements.apiKeys.value = config.apiKeys || "";
    elements.mediaFetchTimeoutMs.value = config.mediaFetchTimeoutMs || "";
    elements.publicBaseUrl.value = config.publicBaseUrl || "";
    elements.requestBodyLimit.value = config.requestBodyLimit || "";
}

function renderExample() {
    const runtime = state.runtime || {};
    const network = runtime.network || {};
    const config = state.config || {};
    const openaiBaseUrl = network.openai_base_url || "";
    const apiKey = String(config.apiKeys || "")
        .split(",")
        .map(item => item.trim())
        .find(Boolean);

    if (!openaiBaseUrl) {
        elements.exampleOutput.textContent = "当前还没有可用的 OpenAI API 地址。";
        return;
    }

    const authLine = apiKey ? `  -H "Authorization: Bearer ${apiKey}" \\\n` : "";
    elements.exampleOutput.textContent = [
        `curl ${openaiBaseUrl}/chat/completions \\`,
        authLine + '  -H "Content-Type: application/json" \\',
        `  -d '{"model":"${toDisplayModelId(config.ai8DefaultModel || "openai_chat::gpt-4.1-mini")}","messages":[{"role":"user","content":"请回复 OK"}]}'`,
    ].join("\n");
}

function toDisplayModelId(value) {
    const text = String(value || "").trim();
    if (!text) {
        return text;
    }

    const parts = text.split("::");
    return parts[parts.length - 1] || text;
}

function resetRuntimePanels() {
    elements.adminModeValue.textContent = "未登录";
    elements.openaiBaseValue.textContent = "-";
    elements.runtimeGrid.innerHTML = "<div><dt>状态</dt><dd>请先登录后台。</dd></div>";
    elements.modelsMeta.textContent = "尚未加载模型。";
    elements.modelsList.innerHTML = "";
    elements.logsOutput.textContent = "尚未加载日志。";
    elements.exampleOutput.textContent = "登录后会在这里生成 curl 调用示例。";
}

async function requestJson(url, options = {}) {
    const headers = {
        ...(options.headers || {}),
        Authorization: `Bearer ${state.adminToken}`,
    };

    const response = await fetch(url, {
        ...options,
        headers,
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
        const message = payload?.error?.message || `${response.status} ${response.statusText}`;
        throw new Error(message);
    }

    return payload;
}

function setStatus(message, type = "") {
    elements.statusBanner.className = `status-banner${type ? ` ${type}` : ""}`;
    elements.statusBanner.textContent = message;
}

function toNumberString(value) {
    const trimmed = String(value || "").trim();
    if (trimmed === "") {
        return "";
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? String(parsed) : "";
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
