import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const userscriptPath = path.join(directory, "..", "baidupan-autosave.user.js");
const source = fs.readFileSync(userscriptPath, "utf8");

function loadTestApi(overrides = {}) {
    const context = {
        __BAIDUPAN_AUTOSAVE_TEST_MODE__: true,
        URL,
        URLSearchParams,
        Date,
        Error,
        TypeError,
        Math,
        JSON,
        Object,
        Promise,
        Symbol,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        console,
        navigator: {
            locks: {
                request: async (_name, _options, callback) => callback({})
            }
        },
        ...overrides
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    return context.__BAIDUPAN_AUTOSAVE_TEST_API__;
}

const api = loadTestApi();

test("metadata exposes a stable raw update URL", () => {
    assert.match(source, /@version\s+1\.4\.0/);
    assert.match(
        source,
        /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/jitdor\/userscript-baidupan-autosave\/main\/baidupan-autosave\.user\.js/
    );
    assert.match(source, /@grant\s+GM_registerMenuCommand/);
});

test("destination paths are normalized", () => {
    assert.equal(api.normalizeDestinationPath("downloads"), "/downloads");
    assert.equal(
        api.normalizeDestinationPath(" /media//incoming/ "),
        "/media/incoming"
    );
    assert.equal(api.normalizeDestinationPath("/"), "/");
});

test("unsafe destination paths are rejected", () => {
    assert.throws(() => api.normalizeDestinationPath(""), /cannot be empty/);
    assert.throws(
        () => api.normalizeDestinationPath("/one/../two"),
        /reserved/
    );
    assert.throws(
        () => api.normalizeDestinationPath("/one/bad:name"),
        /reserved/
    );
});

test("nested folders are created from parent to child", () => {
    assert.deepEqual(
        Array.from(api.destinationAncestors("/one/two/three")),
        ["/one", "/one/two", "/one/two/three"]
    );
});

test("job identity includes the destination path", () => {
    const context = {shareId: "123"};
    const first = api.buildJobIdentity(context, ["456"], "/one");
    const second = api.buildJobIdentity(context, ["456"], "/two");

    assert.notEqual(first.key, second.key);
    assert.notEqual(first.signature, second.signature);
});

test("retry classification stops on permanent account/share failures", () => {
    assert.equal(
        api.isRetryableError(new Error("Sign in to your Baidu Pan account")),
        false
    );
    assert.equal(
        api.isRetryableError(new Error("temporary transfer failure")),
        true
    );

    const transient = new Error("HTTP 429");
    transient.transient = true;
    assert.equal(api.isRetryableError(transient), true);
});

test("retry delays honor Retry-After", () => {
    const error = new Error("rate limited");
    error.retryAfterMilliseconds = 9000;
    assert.equal(api.getRetryDelayMilliseconds(error, 0), 9000);
});

test("a failed globally locked job executes exactly once", async () => {
    const lockedApi = loadTestApi();
    let invocationCount = 0;

    await assert.rejects(
        () => lockedApi.withGlobalTransferLock(async () => {
            invocationCount += 1;
            throw new Error("transfer failed");
        }),
        /transfer failed/
    );
    assert.equal(invocationCount, 1);
});
