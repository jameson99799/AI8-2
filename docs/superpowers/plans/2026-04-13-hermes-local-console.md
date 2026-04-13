# Hermes Local Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chinese local control panel that repairs or reinitializes the Hermes WSL2 runtime, manages Hermes API/gateway services, edits OpenAI-compatible provider settings, and gives Cherry Studio a working local endpoint.

**Architecture:** Reuse the existing Express + Vue app as the control plane. Add a backend Hermes management layer that shells out through `wsl.exe`, reads and writes Hermes `config.yaml` and `.env`, probes OpenAI-compatible `/models`, and starts or stops Hermes services. Extend the current single status page into a Chinese multi-panel console with provider settings, service controls, gateway templates, setup wizards, and copy-ready Cherry Studio connection info.

**Tech Stack:** Node.js, Express, Vue 3, Vite, Element Plus, PowerShell/WSL interop, YAML text parsing with filesystem-backed config writes.

---

### Task 1: Define Hermes Control Boundaries

**Files:**
- Create: `src/hermes/HermesPaths.js`
- Create: `src/hermes/HermesErrors.js`
- Test: manual smoke check through `node -e "require('./src/hermes/HermesPaths')"`

- [ ] **Step 1: Write the minimal boundary module definitions**

```js
const os = require("os");
const path = require("path");

const WINDOWS_HERMES_HOME = path.join(os.homedir(), "AppData", "Local", "hermes");
const WINDOWS_HERMES_CONFIG = path.join(WINDOWS_HERMES_HOME, "config.yaml");
const WINDOWS_HERMES_ENV = path.join(WINDOWS_HERMES_HOME, ".env");
const WINDOWS_HERMES_RUNTIME = path.join(WINDOWS_HERMES_HOME, "runtime");
const WINDOWS_HERMES_LOGS = path.join(WINDOWS_HERMES_HOME, "logs");

const WSL_DISTRO = process.env.HERMES_WSL_DISTRO || "Ubuntu";
const WSL_HERMES_HOME = "~/.hermes";
const WSL_HERMES_CONFIG = "~/.hermes/config.yaml";
const WSL_HERMES_ENV = "~/.hermes/.env";
const WSL_HERMES_PROJECT = "~/hermes-agent";
const DEFAULT_HERMES_API_PORT = Number(process.env.HERMES_API_PORT || 8642);

module.exports = {
    DEFAULT_HERMES_API_PORT,
    WINDOWS_HERMES_CONFIG,
    WINDOWS_HERMES_ENV,
    WINDOWS_HERMES_HOME,
    WINDOWS_HERMES_LOGS,
    WINDOWS_HERMES_RUNTIME,
    WSL_DISTRO,
    WSL_HERMES_CONFIG,
    WSL_HERMES_ENV,
    WSL_HERMES_HOME,
    WSL_HERMES_PROJECT,
};
```

- [ ] **Step 2: Write the error type used by all Hermes management routes**

```js
class HermesControlError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = "HermesControlError";
        this.code = options.code || "HERMES_CONTROL_ERROR";
        this.details = options.details || null;
        this.statusCode = options.statusCode || 500;
    }
}

module.exports = { HermesControlError };
```

- [ ] **Step 3: Run a minimal module load check**

Run: `node -e "const p=require('./src/hermes/HermesPaths'); console.log(p.WSL_DISTRO, p.DEFAULT_HERMES_API_PORT)"`
Expected: prints `Ubuntu 8642` (or your overridden values) without throwing.

- [ ] **Step 4: Commit**

```bash
git add src/hermes/HermesPaths.js src/hermes/HermesErrors.js
git commit -m "feat: add hermes control path definitions"
```

### Task 2: Add WSL and Process Control Primitives

**Files:**
- Create: `src/hermes/HermesShell.js`
- Create: `src/hermes/HermesRuntimeService.js`
- Test: manual command probes from Node

- [ ] **Step 1: Write the WSL command runner**

```js
const { execFile } = require("child_process");
const { promisify } = require("util");
const { WSL_DISTRO } = require("./HermesPaths");
const { HermesControlError } = require("./HermesErrors");

const execFileAsync = promisify(execFile);

async function runWsl(command, options = {}) {
    try {
        const result = await execFileAsync(
            "wsl.exe",
            ["-d", WSL_DISTRO, "--", "bash", "-lc", command],
            {
                encoding: "utf8",
                maxBuffer: 1024 * 1024 * 8,
                timeout: options.timeout ?? 60_000,
                windowsHide: true,
            }
        );

        return {
            command,
            stderr: result.stderr || "",
            stdout: result.stdout || "",
        };
    } catch (error) {
        throw new HermesControlError("WSL command failed", {
            code: "WSL_COMMAND_FAILED",
            details: {
                command,
                stderr: error.stderr || "",
                stdout: error.stdout || "",
            },
            statusCode: 500,
        });
    }
}

module.exports = { runWsl };
```

- [ ] **Step 2: Write the runtime manager skeleton**

```js
const fs = require("fs/promises");
const path = require("path");
const {
    DEFAULT_HERMES_API_PORT,
    WINDOWS_HERMES_RUNTIME,
    WSL_HERMES_PROJECT,
} = require("./HermesPaths");
const { runWsl } = require("./HermesShell");

class HermesRuntimeService {
    async ensureRuntimeDir() {
        await fs.mkdir(WINDOWS_HERMES_RUNTIME, { recursive: true });
    }

    async getWslStatus() {
        const result = await runWsl("pwd && python3 --version", { timeout: 30_000 });
        return {
            ok: true,
            raw: result.stdout.trim(),
        };
    }

    async getServiceStatus() {
        const api = await runWsl(
            `if pgrep -af "hermes.*api" >/dev/null; then echo running; else echo stopped; fi`
        );
        const gateway = await runWsl(
            `if pgrep -af "hermes.*gateway" >/dev/null; then echo running; else echo stopped; fi`
        );

        return {
            apiPort: DEFAULT_HERMES_API_PORT,
            apiStatus: api.stdout.trim(),
            gatewayStatus: gateway.stdout.trim(),
        };
    }

    async stopApiServer() {
        await runWsl(`pkill -f "hermes.*api" || true`);
    }

    async stopGateway() {
        await runWsl(`pkill -f "hermes.*gateway" || true`);
    }

    async startApiServer() {
        await this.ensureRuntimeDir();
        await runWsl(
            `cd ${WSL_HERMES_PROJECT} && nohup hermes api --host 0.0.0.0 --port ${DEFAULT_HERMES_API_PORT} > ~/.hermes/logs/api-server.log 2>&1 < /dev/null &`
        );
        return this.getServiceStatus();
    }

    async startGateway() {
        await this.ensureRuntimeDir();
        await runWsl(
            `cd ${WSL_HERMES_PROJECT} && nohup hermes gateway > ~/.hermes/logs/gateway.log 2>&1 < /dev/null &`
        );
        return this.getServiceStatus();
    }
}

module.exports = HermesRuntimeService;
```

- [ ] **Step 3: Run direct runtime probes**

Run: `node -e "const S=require('./src/hermes/HermesRuntimeService'); new S().getWslStatus().then(console.log).catch(err=>{console.error(err); process.exit(1);})"`
Expected: either a structured `ok: true` payload or a clear WSL failure object that will be surfaced in the UI.

- [ ] **Step 4: Commit**

```bash
git add src/hermes/HermesShell.js src/hermes/HermesRuntimeService.js
git commit -m "feat: add hermes runtime shell controls"
```

### Task 3: Add Hermes Config Read/Write and Model Discovery

**Files:**
- Create: `src/hermes/HermesConfigService.js`
- Create: `src/hermes/OpenAICompatibleProbe.js`
- Test: manual Node probes against current config and a test `/models` endpoint

- [ ] **Step 1: Write the config reader and updater**

```js
const fs = require("fs/promises");
const path = require("path");
const yaml = require("yaml");
const {
    WINDOWS_HERMES_CONFIG,
    WINDOWS_HERMES_ENV,
    DEFAULT_HERMES_API_PORT,
} = require("./HermesPaths");

class HermesConfigService {
    async readConfig() {
        const raw = await fs.readFile(WINDOWS_HERMES_CONFIG, "utf8");
        return yaml.parse(raw);
    }

    async readEnv() {
        try {
            return await fs.readFile(WINDOWS_HERMES_ENV, "utf8");
        } catch {
            return "";
        }
    }

    async saveProviderConfig({ apiKey, apiUrl, model }) {
        const config = (await this.readConfig()) || {};
        config.model = {
            ...(config.model || {}),
            base_url: apiUrl,
            default: model,
            provider: "custom",
        };
        config.custom_providers = [
            {
                api_key: "",
                api_mode: "chat_completions",
                base_url: apiUrl,
                model,
                name: "custom-local-console",
            },
        ];
        await fs.writeFile(WINDOWS_HERMES_CONFIG, yaml.stringify(config), "utf8");

        const envText = await this.readEnv();
        const nextEnv = upsertEnvValue(envText, "OPENAI_API_KEY", apiKey);
        await fs.writeFile(WINDOWS_HERMES_ENV, nextEnv, "utf8");

        return {
            apiPort: DEFAULT_HERMES_API_PORT,
            apiUrl,
            model,
        };
    }
}

function upsertEnvValue(source, key, value) {
    const lines = (source || "").split(/\r?\n/);
    const next = [];
    let found = false;

    for (const line of lines) {
        if (line.startsWith(`${key}=`)) {
            next.push(`${key}=${value}`);
            found = true;
        } else if (line.length > 0 || next.length > 0) {
            next.push(line);
        }
    }

    if (!found) {
        next.push(`${key}=${value}`);
    }

    return `${next.filter(Boolean).join("\n")}\n`;
}

module.exports = { HermesConfigService, upsertEnvValue };
```

- [ ] **Step 2: Write the OpenAI-compatible `/models` probe**

```js
const axios = require("axios");
const { HermesControlError } = require("./HermesErrors");

async function fetchOpenAICompatibleModels({ apiKey, apiUrl }) {
    try {
        const response = await axios.get(new URL("/models", apiUrl).toString(), {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            timeout: 15_000,
        });

        return (response.data?.data || []).map(item => ({
            id: item.id,
            label: item.id,
        }));
    } catch (error) {
        throw new HermesControlError("Failed to fetch model list", {
            code: "MODEL_DISCOVERY_FAILED",
            details: error.response?.data || error.message,
            statusCode: 400,
        });
    }
}

module.exports = { fetchOpenAICompatibleModels };
```

- [ ] **Step 3: Run config and probe checks**

Run: `node -e "const {HermesConfigService}=require('./src/hermes/HermesConfigService'); new HermesConfigService().readConfig().then(v=>console.log(v.model)).catch(err=>{console.error(err); process.exit(1);})"`
Expected: prints the current Hermes model configuration.

Run: `node -e "const {fetchOpenAICompatibleModels}=require('./src/hermes/OpenAICompatibleProbe'); fetchOpenAICompatibleModels({apiUrl:'http://localhost:8317/v1', apiKey:process.env.OPENAI_API_KEY||''}).then(v=>console.log(v.slice(0,3))).catch(err=>{console.error(err.message); process.exit(1);})"`
Expected: prints a short model array when the target endpoint supports `/models`, otherwise a controlled probe error.

- [ ] **Step 4: Commit**

```bash
git add src/hermes/HermesConfigService.js src/hermes/OpenAICompatibleProbe.js
git commit -m "feat: add hermes config and model discovery services"
```

### Task 4: Expose Hermes Management APIs in Express

**Files:**
- Create: `src/routes/HermesRoutes.js`
- Modify: `src/core/ProxyServerSystem.js`
- Test: `curl` or browser requests to new `/api/hermes/*` endpoints

- [ ] **Step 1: Add the route class**

```js
const HermesRuntimeService = require("../hermes/HermesRuntimeService");
const { HermesConfigService } = require("../hermes/HermesConfigService");
const { fetchOpenAICompatibleModels } = require("../hermes/OpenAICompatibleProbe");

class HermesRoutes {
    constructor(serverSystem) {
        this.runtime = new HermesRuntimeService();
        this.config = new HermesConfigService();
        this.logger = serverSystem.logger;
    }

    setupRoutes(app, isAuthenticated) {
        app.get("/api/hermes/summary", isAuthenticated, async (req, res) => {
            const [serviceStatus, config] = await Promise.all([
                this.runtime.getServiceStatus(),
                this.config.readConfig(),
            ]);

            res.json({
                config,
                services: serviceStatus,
            });
        });

        app.post("/api/hermes/models/discover", isAuthenticated, async (req, res) => {
            const models = await fetchOpenAICompatibleModels(req.body);
            res.json({ models });
        });

        app.put("/api/hermes/provider", isAuthenticated, async (req, res) => {
            const saved = await this.config.saveProviderConfig(req.body);
            const status = await this.runtime.startApiServer();
            res.json({ saved, status });
        });

        app.post("/api/hermes/services/:service/start", isAuthenticated, async (req, res) => {
            const result =
                req.params.service === "gateway"
                    ? await this.runtime.startGateway()
                    : await this.runtime.startApiServer();
            res.json(result);
        });

        app.post("/api/hermes/services/:service/stop", isAuthenticated, async (req, res) => {
            if (req.params.service === "gateway") {
                await this.runtime.stopGateway();
            } else {
                await this.runtime.stopApiServer();
            }
            res.json(await this.runtime.getServiceStatus());
        });
    }
}

module.exports = HermesRoutes;
```

- [ ] **Step 2: Register the route in the server bootstrap**

```js
const HermesRoutes = require("../routes/HermesRoutes");

// after StatusRoutes/AuthRoutes construction
this.hermesRoutes = new HermesRoutes(this);

// in route registration
this.hermesRoutes.setupRoutes(app, isAuthenticated);
```

- [ ] **Step 3: Start the app and verify new endpoints**

Run: `npm run dev:server`
Expected: Express server starts without route registration errors.

Run: `curl http://localhost:7861/api/hermes/summary`
Expected: authenticated environments return Hermes config/service JSON; unauthenticated environments return the existing login behavior.

- [ ] **Step 4: Commit**

```bash
git add src/routes/HermesRoutes.js src/core/ProxyServerSystem.js
git commit -m "feat: expose hermes management endpoints"
```

### Task 5: Build the Chinese Hermes Console UI

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`
- Modify: `ui/app/router/index.js`
- Create: `ui/app/components/hermes/HermesOverviewPanel.vue`
- Create: `ui/app/components/hermes/HermesProviderForm.vue`
- Create: `ui/app/components/hermes/HermesServicePanel.vue`
- Create: `ui/app/components/hermes/HermesWizardPanel.vue`
- Test: Vite build and manual browser check

- [ ] **Step 1: Split the giant status page into Hermes-focused panels**

```vue
<template>
  <div class="hermes-console-grid">
    <HermesOverviewPanel :summary="hermesSummary" />
    <HermesProviderForm
      :loading="providerSaving"
      :models="discoveredModels"
      :value="providerForm"
      @discover-models="discoverModels"
      @save="saveProvider"
    />
    <HermesServicePanel
      :services="hermesSummary.services"
      @start="startService"
      @stop="stopService"
    />
    <HermesWizardPanel
      :platform-presets="platformPresets"
      @apply-preset="applyPreset"
    />
  </div>
</template>
```

- [ ] **Step 2: Add Chinese-first copy and action flow**

```js
const providerForm = reactive({
    apiKey: "",
    apiUrl: "",
    model: "",
});

const discoverModels = async () => {
    const response = await fetch("/api/hermes/models/discover", {
        body: JSON.stringify(providerForm),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });
    const data = await response.json();
    discoveredModels.value = data.models || [];
};

const saveProvider = async () => {
    const response = await fetch("/api/hermes/provider", {
        body: JSON.stringify(providerForm),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
    });
    const data = await response.json();
    hermesSummary.value.services = data.status;
};
```

- [ ] **Step 3: Add a Cherry Studio copy section in the overview panel**

```vue
<div class="copy-card">
  <h3>Cherry Studio 连接信息</h3>
  <p>接口地址：{{ apiEndpoint }}</p>
  <p>API Key：{{ maskedApiKey }}</p>
  <p>模型：{{ defaultModel }}</p>
  <el-button @click="$emit('copy-endpoint')">复制接口地址</el-button>
</div>
```

- [ ] **Step 4: Verify the front-end compiles**

Run: `npm run build:ui`
Expected: Vite builds successfully and emits updated assets into `dist/`.

- [ ] **Step 5: Commit**

```bash
git add ui/app/pages/StatusPage.vue ui/app/router/index.js ui/app/components/hermes
git commit -m "feat: add chinese hermes control console"
```

### Task 6: Add Platform Templates, Guide Copy, and Immediate-Effect Semantics

**Files:**
- Create: `src/hermes/HermesPlatformTemplates.js`
- Modify: `src/routes/HermesRoutes.js`
- Modify: `ui/locales/zh.json`
- Modify: `ui/locales/en.json`
- Test: save a platform template and verify the route response

- [ ] **Step 1: Define supported platform templates**

```js
module.exports = {
    wechat: {
        description: "微信接入向导",
        envKeys: ["WECHAT_APP_ID", "WECHAT_APP_SECRET"],
        restartTarget: "gateway",
        steps: [
            "在微信开放平台创建应用。",
            "填写 AppID 与 AppSecret。",
            "保存后重启 Gateway。",
        ],
    },
    telegram: {
        description: "Telegram 机器人向导",
        envKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"],
        restartTarget: "gateway",
        steps: [
            "通过 BotFather 创建机器人。",
            "填写 Bot Token。",
            "配置允许访问的用户 ID。",
        ],
    },
};
```

- [ ] **Step 2: Add a route that saves template-backed env values and restarts the right service**

```js
app.put("/api/hermes/platforms/:platform", isAuthenticated, async (req, res) => {
    const result = await this.config.savePlatformConfig(req.params.platform, req.body);
    const status =
        result.restartTarget === "gateway"
            ? await this.runtime.startGateway()
            : await this.runtime.startApiServer();
    res.json({ result, status });
});
```

- [ ] **Step 3: Add localized labels for every UI action**

```json
{
  "hermesConsoleTitle": "Hermes 本地控制台",
  "hermesProviderTitle": "模型接口配置",
  "discoverModels": "获取模型列表",
  "saveAndApply": "保存并立即生效",
  "gatewayWizardTitle": "平台接入向导",
  "cherryStudioTitle": "Cherry Studio 调用信息"
}
```

- [ ] **Step 4: Verify the i18n files and platform save flow**

Run: `npm run lint:js`
Expected: no syntax errors in route code and Vue/i18n imports.

- [ ] **Step 5: Commit**

```bash
git add src/hermes/HermesPlatformTemplates.js src/routes/HermesRoutes.js ui/locales/zh.json ui/locales/en.json
git commit -m "feat: add platform templates and localized guide copy"
```

### Task 7: Repair WSL2 Bootstrap and Runtime Visibility

**Files:**
- Create: `src/hermes/HermesBootstrapService.js`
- Modify: `src/routes/HermesRoutes.js`
- Test: run bootstrap probe from the API

- [ ] **Step 1: Add a bootstrap service that diagnoses broken WSL instances**

```js
const { runWsl } = require("./HermesShell");

class HermesBootstrapService {
    async diagnose() {
        try {
            const result = await runWsl("echo ready && uname -a", { timeout: 30_000 });
            return { ready: true, message: result.stdout.trim() };
        } catch (error) {
            return {
                ready: false,
                message: "WSL 当前不可用，需重新初始化 Ubuntu 实例。",
                details: error.details || null,
            };
        }
    }
}

module.exports = HermesBootstrapService;
```

- [ ] **Step 2: Expose a bootstrap diagnostics endpoint**

```js
app.get("/api/hermes/bootstrap", isAuthenticated, async (req, res) => {
    res.json(await this.bootstrap.diagnose());
});
```

- [ ] **Step 3: Verify the bootstrap endpoint**

Run: `curl http://localhost:7861/api/hermes/bootstrap`
Expected: a clear `ready: true/false` JSON object, not a raw shell error dump.

- [ ] **Step 4: Commit**

```bash
git add src/hermes/HermesBootstrapService.js src/routes/HermesRoutes.js
git commit -m "feat: add hermes bootstrap diagnostics"
```

### Task 8: End-to-End Verification

**Files:**
- Modify: `README.md`
- Test: full-stack runbook only

- [ ] **Step 1: Add a concise usage section for the local console**

```md
## Hermes Local Console

1. Start the app with `npm run dev`
2. Open the status page
3. Fill in OpenAI-compatible API URL, API key, and model
4. Click “保存并立即生效”
5. Copy the Cherry Studio endpoint from the dashboard
```

- [ ] **Step 2: Run the full verification commands**

Run: `npm run build:ui`
Expected: build succeeds.

Run: `npm run lint:js`
Expected: lint succeeds.

Run: `node -e "const S=require('./src/hermes/HermesRuntimeService'); new S().getServiceStatus().then(console.log).catch(err=>{console.error(err); process.exit(1);})"`
Expected: service status JSON prints cleanly.

- [ ] **Step 3: Manually verify the product goals**

Checklist:
- The UI is Chinese-first.
- The provider form accepts `Base URL`, `API Key`, and `Model`.
- The UI can attempt `/models` discovery.
- Saving config triggers service restart and new status.
- The dashboard exposes a Cherry Studio-ready local endpoint.
- Platform templates and wizard copy are visible.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add hermes local console usage"
```
