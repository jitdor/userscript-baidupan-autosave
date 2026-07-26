import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const userscriptPath = path.join(directory, "..", "baidupan-autosave.user.js");
const source = fs.readFileSync(userscriptPath, "utf8");

function createMemoryStorage() {
    const values = new Map();

    return {
        get length() {
            return values.size;
        },
        key(index) {
            return [...values.keys()][index] ?? null;
        },
        getItem(key) {
            return values.has(String(key))
                ? values.get(String(key))
                : null;
        },
        setItem(key, value) {
            values.set(String(key), String(value));
        },
        removeItem(key) {
            values.delete(String(key));
        }
    };
}

function createFakeDocument() {
    const elementsById = new Map();

    function register(element) {
        if (element.id) elementsById.set(element.id, element);
        for (const child of element.children) register(child);
    }

    function createElement(tagName) {
        const element = {
            tagName,
            style: {},
            children: [],
            listeners: {},
            textContent: "",
            appendChild(child) {
                this.children.push(child);
                child.parentNode = this;
                register(child);
                return child;
            },
            append(...children) {
                for (const child of children) this.appendChild(child);
            },
            removeChild(child) {
                const index = this.children.indexOf(child);
                if (index >= 0) this.children.splice(index, 1);
                if (child.id) elementsById.delete(child.id);
                return child;
            },
            setAttribute(name, value) {
                this[name] = value;
            },
            addEventListener(name, listener) {
                this.listeners[name] = listener;
            }
        };
        Object.defineProperty(element, "firstChild", {
            get() {
                return this.children[0] || null;
            }
        });
        return element;
    }

    const root = createElement("html");

    return {
        body: root,
        documentElement: root,
        title: "Test share",
        createElement,
        querySelector(selector) {
            if (!selector.startsWith("#")) return null;
            return elementsById.get(selector.slice(1)) || null;
        },
        addEventListener() {}
    };
}

function findElement(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children || []) {
        const match = findElement(child, predicate);
        if (match) return match;
    }
    return null;
}

function loadTestApi(overrides = {}) {
    const context = {
        __BAIDUPAN_AUTOSAVE_TEST_MODE__: true,
        AbortController,
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
        localStorage: createMemoryStorage(),
        addEventListener() {},
        navigator: {
            locks: {
                request: async (_name, _options, callback) => callback({})
            }
        },
        ...overrides
    };
    context.window = context;
    context.self = context;
    if (!Object.hasOwn(context, "top")) context.top = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    return context.__BAIDUPAN_AUTOSAVE_TEST_API__;
}

const api = loadTestApi();

test("metadata exposes a stable raw update URL", () => {
    assert.match(source, /@version\s+1\.0\.3/);
    assert.match(
        source,
        /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/jitdor\/userscript-baidupan-autosave\/main\/baidupan-autosave\.user\.js/
    );
    assert.match(source, /@grant\s+GM_registerMenuCommand/);
});

test("the settings control only mounts in the top-level document", () => {
    const topDocument = createFakeDocument();
    const topApi = loadTestApi({document: topDocument});
    assert.equal(topApi.mountSettingsButton(), true);
    assert.ok(topDocument.querySelector("#baidupan-autosave-settings"));

    const frameDocument = createFakeDocument();
    const frameApi = loadTestApi({document: frameDocument, top: {}});
    assert.equal(frameApi.mountSettingsButton(), false);
    assert.equal(
        frameDocument.querySelector("#baidupan-autosave-settings"),
        null
    );
});

test("the on-page control saves a normalized destination", async () => {
    const document = createFakeDocument();
    let savedDestination;
    const controlApi = loadTestApi({
        document,
        prompt: () => " /adguard//incoming/ ",
        alert: (message) => assert.fail(message),
        GM_getValue: (_key, fallback) => fallback,
        GM_setValue: (_key, value) => {
            savedDestination = value;
        }
    });
    const first = controlApi.ensureSettingsButton();
    const second = controlApi.ensureSettingsButton();

    assert.equal(first, second);
    assert.equal(first.tagName, "button");
    assert.equal(first.textContent, "⚙ Auto-save");
    assert.equal(first.style.position, "fixed");
    assert.equal(typeof first.listeners.click, "function");

    first.listeners.click({
        preventDefault() {},
        stopPropagation() {}
    });
    const panel = document.querySelector("#baidupan-autosave-queue-panel");
    assert.ok(panel);
    assert.equal(panel.style.display, "block");

    const changeDestination = findElement(
        panel,
        (element) => element.textContent === "Change destination"
    );
    assert.ok(changeDestination);
    changeDestination.listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(savedDestination, "/adguard/incoming");
    assert.match(first.title, /Current destination: \/adguard\/incoming/);
    first.listeners.click({
        preventDefault() {},
        stopPropagation() {}
    });
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

test("requests time out while waiting for a response", async () => {
    const timeoutApi = loadTestApi({
        fetch: (_resource, options) =>
            new Promise((_resolve, reject) => {
                options.signal.addEventListener("abort", () => {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                });
            })
    });

    await assert.rejects(
        () => timeoutApi.fetchWithTimeout("/api/test", {}, 5),
        (error) =>
            error.name === "TimeoutError" &&
            error.transient === true
    );
});

test("the timeout also covers reading the response body", async () => {
    const timeoutApi = loadTestApi({
        fetch: async (_resource, options) => ({
            ok: true,
            text: () =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener("abort", () => {
                        const error = new Error("aborted");
                        error.name = "AbortError";
                        reject(error);
                    });
                })
        })
    });

    await assert.rejects(
        () => timeoutApi.fetchWithTimeout(
            "/share",
            {},
            5,
            (response) => response.text()
        ),
        (error) =>
            error.name === "TimeoutError" &&
            error.transient === true
    );
});

test("the global write lock is released before a failed job retries", async () => {
    let lockHeld = false;
    const lockApi = loadTestApi({
        document: createFakeDocument(),
        navigator: {
            locks: {
                request: async (_name, _options, callback) => {
                    lockHeld = true;
                    try {
                        return await callback({});
                    } finally {
                        lockHeld = false;
                    }
                },
                query: async () => ({held: [], pending: []})
            }
        }
    });

    await assert.rejects(
        () => lockApi.performGlobalWrite("test write", async () => {
            assert.equal(lockHeld, true);
            throw new Error("temporary failure");
        }),
        /temporary failure/
    );
    assert.equal(lockHeld, false);
});

test("the queue registry reports active jobs across tabs", () => {
    const queueApi = loadTestApi({
        document: createFakeDocument()
    });

    queueApi.updateQueueEntry({
        state: "retrying",
        detail: "Waiting 12s",
        destinationPath: "/incoming",
        itemCount: 1
    });

    const entries = queueApi.listQueueEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, "retrying");
    assert.equal(entries[0].destinationPath, "/incoming");
});

test("whole jobs use a per-job lock rather than the global write lock", () => {
    assert.match(source, /await withJobLock\(/);
    assert.doesNotMatch(
        source,
        /withGlobalTransferLock\(\s*\(\) => processTransferJob/
    );
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
