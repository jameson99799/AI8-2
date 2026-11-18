"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    fetchAggregatedModels,
    invalidateModelPool,
} = require("../lib/channel-manager");

function makeConfig(overrides = {}) {
    return {
        ai8Enabled: true,
        blacklistedModels: [],
        ai8BlacklistedModels: [],
        ai8AllowedModels: [],
        gptallEnabled: false,
        gptallBlacklistedModels: [],
        freegptEnabled: false,
        freegptBlacklistedModels: [],
        lsshirtaiEnabled: false,
        customChannels: [],
        ...overrides,
    };
}

test("concurrent readers join one aggregation instead of stacking upstream calls", async () => {
    invalidateModelPool();
    let fetchCount = 0;
    const fakeClient = {
        fetchModels: async () => {
            fetchCount += 1;
            return [{ value: "openai_chat::m1" }];
        },
    };
    const config = makeConfig();

    const [a, b] = await Promise.all([
        fetchAggregatedModels(fakeClient, config, false, null, false),
        fetchAggregatedModels(fakeClient, config, false, null, false),
    ]);

    assert.equal(fetchCount, 1);
    assert.ok(a.some(m => m.value === "openai_chat::m1【AI8直连】"));
    assert.deepEqual(a.map(m => m.value), b.map(m => m.value));
});

test("draw scrape does not block automatic aggregation", async () => {
    invalidateModelPool();
    let drawScrapes = 0;
    const fakeClient = {
        fetchModels: async () => [{ value: "openai_chat::m1" }],
        fetchDrawModels: async () => {
            drawScrapes += 1;
            await new Promise(resolve => setTimeout(resolve, 200));
            return [{ model: "gpt-image-2", version: "gpt-image-2-scraped" }];
        },
    };
    const config = makeConfig();

    const startedAt = Date.now();
    const models = await fetchAggregatedModels(fakeClient, config, false, null, false);
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 100, `aggregation must not wait for the slow draw scrape (took ${elapsed}ms)`);
    // The static fallback list is served while the scrape runs in the background.
    assert.ok(models.some(m => m._source === "ai8" && m.origId === "mj"));
    assert.ok(!models.some(m => m.origId === "gpt-image-2-scraped"));

    await new Promise(resolve => setTimeout(resolve, 320));
    assert.equal(drawScrapes, 1);
});

test("forced refresh still waits for the real draw scrape", async () => {
    invalidateModelPool();
    let drawScrapes = 0;
    const fakeClient = {
        fetchModels: async () => [{ value: "openai_chat::m1" }],
        fetchDrawModels: async (forceRefresh) => {
            drawScrapes += 1;
            assert.equal(forceRefresh, true);
            await new Promise(resolve => setTimeout(resolve, 60));
            return [{ model: "gpt-image-2", version: "gpt-image-2-scraped" }];
        },
    };
    const config = makeConfig();

    const models = await fetchAggregatedModels(fakeClient, config, true, null, false);
    assert.equal(drawScrapes, 1);
    assert.ok(models.some(m => m.origId === "gpt-image-2-scraped"));
});

test("stale pool is served instantly while the refresh happens in the background", async (t) => {
    invalidateModelPool();
    let fetchCount = 0;
    let pendingResolve = null;
    const fakeClient = {
        fetchModels: () => new Promise(resolve => {
            fetchCount += 1;
            pendingResolve = resolve;
        }),
    };
    const config = makeConfig();

    // First aggregation: an empty cache blocks until the upstream answers.
    const first = fetchAggregatedModels(fakeClient, config, false, null, false);
    pendingResolve([{ value: "m1" }]);
    const firstModels = await first;
    assert.equal(fetchCount, 1);
    assert.ok(firstModels.some(m => m.value === "m1【AI8直连】"));

    // Expire the pool without real waiting.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(6 * 60 * 1000);

    // Stale serve: returns immediately with cached entries; a background
    // refresh starts (fetchCount increments) but is not awaited.
    const stale = await fetchAggregatedModels(fakeClient, config, false, null, false);
    assert.equal(fetchCount, 2);
    assert.ok(stale.some(m => m.value === "m1【AI8直连】"));

    // Complete the background refresh with new upstream data.
    pendingResolve([{ value: "m2" }]);
    await new Promise(resolve => setTimeout(resolve, 10));
    t.mock.timers.reset();

    // Next read serves the refreshed pool without another upstream call.
    const refreshed = await fetchAggregatedModels(fakeClient, config, false, null, false);
    assert.equal(fetchCount, 2);
    assert.ok(refreshed.some(m => m.value === "m2【AI8直连】"));
});

test("forced refresh returns fresh data even when the pool is stale", async (t) => {
    invalidateModelPool();
    let payload = [{ value: "m-old" }];
    let fetchCount = 0;
    const fakeClient = {
        fetchModels: async () => {
            fetchCount += 1;
            return payload;
        },
    };
    const config = makeConfig();

    await fetchAggregatedModels(fakeClient, config, false, null, false);
    assert.equal(fetchCount, 1);

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(6 * 60 * 1000);

    payload = [{ value: "m-new" }];
    const forced = await fetchAggregatedModels(fakeClient, config, true, null, false);
    assert.equal(fetchCount, 2);
    assert.ok(forced.some(m => m.value === "m-new【AI8直连】"));
    t.mock.timers.reset();

    // The pool was replaced by the forced refresh; a normal read must not
    // re-serve the stale data.
    const after = await fetchAggregatedModels(fakeClient, config, false, null, false);
    assert.equal(fetchCount, 2);
    assert.ok(after.some(m => m.value === "m-new【AI8直连】"));
    assert.ok(!after.some(m => m.value === "m-old【AI8直连】"));
});
