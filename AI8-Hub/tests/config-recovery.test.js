"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RuntimeConfigStore = require("../lib/runtime-config");

function makeDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ai8-cfg-recovery-"));
}

test("a config file saved with a UTF-8 BOM still loads", () => {
    const dir = makeDir();
    try {
        const storePath = path.join(dir, "config.json");
        const config = { adminToken: "t", ai8AllowedModels: "m1,m2", ai8CustomModels: "manual-1" };
        fs.writeFileSync(storePath, "\uFEFF" + JSON.stringify(config, null, 2), "utf8");

        const store = new RuntimeConfigStore({ storePath, defaults: { adminToken: "t" } });
        assert.deepEqual(store.getConfig().ai8AllowedModels, ["m1", "m2"]);
        assert.deepEqual(store.getConfig().ai8CustomModels, ["manual-1"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("an unreadable config is quarantined instead of silently discarded", () => {
    const dir = makeDir();
    try {
        const storePath = path.join(dir, "config.json");
        const broken = '{ "ai8AllowedModels": "m1,m2", "ai8CustomModels": "manual-1", '; // truncated write
        fs.writeFileSync(storePath, broken, "utf8");

        const store = new RuntimeConfigStore({ storePath, defaults: { adminToken: "t" } });
        // Boots with defaults instead of crashing...
        assert.deepEqual(store.getConfig().ai8AllowedModels, []);
        // ...and the broken file is preserved for manual recovery.
        const quarantined = fs.readdirSync(dir).filter(name => name.startsWith("config.json.invalid-"));
        assert.equal(quarantined.length, 1);
        assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), "utf8"), broken);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("an unreadable config falls back to the last good backup", () => {
    const dir = makeDir();
    try {
        const storePath = path.join(dir, "config.json");
        const good = { adminToken: "t", ai8AllowedModels: "m1,m2", ai8CustomModels: "manual-1" };

        // Simulate a previous save leaving a healthy .bak behind, then the
        // live file getting corrupted by a manual edit.
        fs.writeFileSync(path.join(dir, "config.json.bak"), JSON.stringify(good, null, 2), "utf8");
        fs.writeFileSync(storePath, "{ not valid json !!!", "utf8");

        const store = new RuntimeConfigStore({ storePath, defaults: { adminToken: "t" } });
        assert.deepEqual(store.getConfig().ai8AllowedModels, ["m1", "m2"]);
        assert.deepEqual(store.getConfig().ai8CustomModels, ["manual-1"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("saving keeps a .bak of the previous good configuration and writes atomically", () => {
    const dir = makeDir();
    try {
        const storePath = path.join(dir, "config.json");
        const store = new RuntimeConfigStore({ storePath, defaults: { adminToken: "t" } });

        store.updateConfig({ ai8AllowedModels: "old-model" });
        store.updateConfig({ ai8AllowedModels: "new-model" });

        const backup = JSON.parse(fs.readFileSync(path.join(dir, "config.json.bak"), "utf8"));
        assert.deepEqual(backup.ai8AllowedModels, "old-model");

        const live = JSON.parse(fs.readFileSync(storePath, "utf8"));
        assert.equal(live.ai8AllowedModels, "new-model");

        // No temp files left behind.
        assert.ok(!fs.readdirSync(dir).some(name => name.includes(".tmp-")));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
