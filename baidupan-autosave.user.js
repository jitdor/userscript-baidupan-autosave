// ==UserScript==
// @name         Baidu Pan Auto-Save
// @namespace    https://github.com/jitdor/userscript-baidupan-autosave
// @version      1.4.1
// @description  Automatically queues and saves unlocked Baidu Pan shares to a configurable folder.
// @author       jitdor
// @homepageURL  https://github.com/jitdor/userscript-baidupan-autosave
// @supportURL   https://github.com/jitdor/userscript-baidupan-autosave/issues
// @downloadURL  https://raw.githubusercontent.com/jitdor/userscript-baidupan-autosave/main/baidupan-autosave.user.js
// @updateURL    https://raw.githubusercontent.com/jitdor/userscript-baidupan-autosave/main/baidupan-autosave.user.js
// @match        https://pan.baidu.com/*
// @match        https://yun.baidu.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    "use strict";

    const DEFAULT_DESTINATION_PATH = "/wckbot16";
    const DESTINATION_SETTING_KEY = "destinationPath";
    const AUTO_CLOSE_AFTER_SUCCESS = true;
    const AUTO_CLOSE_DELAY_MILLISECONDS = 1500;
    const TRANSFER_BATCH_SIZE = 100;
    const TRANSFER_MAX_ATTEMPTS = 7;
    const RETRY_BASE_DELAY_MILLISECONDS = 1800;
    const RETRY_MAX_DELAY_MILLISECONDS = 30000;
    const MINIMUM_WRITE_INTERVAL_MILLISECONDS = 2500;
    const GLOBAL_LOCK_NAME = "baidupan-autosave-transfer-v1";
    const FALLBACK_LOCK_KEY = "baidupan-autosave:transfer-lock-v1";
    const FALLBACK_LOCK_LEASE_MILLISECONDS = 15000;
    const LAST_WRITE_KEY = "baidupan-autosave:last-write-v1";
    const COOLDOWN_UNTIL_KEY = "baidupan-autosave:cooldown-until-v1";
    const JOB_KEY_PREFIX = "baidupan-autosave:job-v3:";
    const OWNER_ID =
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const pageWindow =
        typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    const sleep = (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds));

    function isPotentialSharePage() {
        const url = new URL(location.href);

        return (
            location.pathname.startsWith("/s/") ||
            location.pathname.startsWith("/share/") ||
            url.searchParams.has("surl") ||
            url.searchParams.has("shareid")
        );
    }

    function normalizeDestinationPath(value) {
        if (typeof value !== "string") {
            throw new TypeError("The destination must be a folder path");
        }

        let path = value.trim().replace(/\\/g, "/");

        if (!path) {
            throw new Error("The destination folder cannot be empty");
        }

        if (!path.startsWith("/")) path = `/${path}`;
        path = path.replace(/\/{2,}/g, "/");
        if (path.length > 1) path = path.replace(/\/+$/, "");

        if (path.length > 1024) {
            throw new Error("The destination folder is too long");
        }

        const segments = path.split("/").filter(Boolean);

        if (
            segments.some(
                (segment) =>
                    segment === "." ||
                    segment === ".." ||
                    /[\u0000-\u001f:*?"<>|]/.test(segment)
            )
        ) {
            throw new Error(
                "The destination contains a reserved name or character"
            );
        }

        return path;
    }

    function getSetting(key, fallbackValue) {
        try {
            if (typeof GM_getValue === "function") {
                return GM_getValue(key, fallbackValue);
            }
        } catch (error) {
            console.warn("[Baidu Pan Auto-Save] Could not read setting", error);
        }

        try {
            return localStorage.getItem(`baidupan-autosave:setting:${key}`) ??
                fallbackValue;
        } catch (_) {
            return fallbackValue;
        }
    }

    async function setSetting(key, value) {
        if (typeof GM_setValue === "function") {
            await Promise.resolve(GM_setValue(key, value));
            return;
        }

        localStorage.setItem(`baidupan-autosave:setting:${key}`, value);
    }

    async function getDestinationPath() {
        const configuredValue = await Promise.resolve(
            getSetting(DESTINATION_SETTING_KEY, DEFAULT_DESTINATION_PATH)
        );

        try {
            return normalizeDestinationPath(configuredValue);
        } catch (error) {
            console.warn(
                "[Baidu Pan Auto-Save] Invalid saved destination; using default",
                error
            );
            return DEFAULT_DESTINATION_PATH;
        }
    }

    async function configureDestinationPath() {
        const currentPath = await getDestinationPath();
        const enteredPath = window.prompt(
            "Baidu Pan destination folder:",
            currentPath
        );

        if (enteredPath === null) return;

        try {
            const nextPath = normalizeDestinationPath(enteredPath);
            await setSetting(DESTINATION_SETTING_KEY, nextPath);
            updateSettingsButtonTitle(nextPath);
            showStatus(
                `Destination changed to ${nextPath}. It will apply to new jobs.`
            );
        } catch (error) {
            window.alert(`Could not save destination: ${error.message}`);
        }
    }

    function registerSettingsMenu() {
        if (typeof GM_registerMenuCommand !== "function") return;

        GM_registerMenuCommand(
            "Set destination folder…",
            () => void configureDestinationPath()
        );
        GM_registerMenuCommand(
            "Reset destination folder",
            async () => {
                await setSetting(
                    DESTINATION_SETTING_KEY,
                    DEFAULT_DESTINATION_PATH
                );
                updateSettingsButtonTitle(DEFAULT_DESTINATION_PATH);
                showStatus(
                    `Destination reset to ${DEFAULT_DESTINATION_PATH}.`
                );
            }
        );
    }

    function updateSettingsButtonTitle(destinationPath) {
        const button = document.querySelector(
            "#baidupan-autosave-settings"
        );
        if (!button) return;

        button.title =
            `Current destination: ${destinationPath}\n` +
            "Click to change the Baidu Pan auto-save destination.";
    }

    function ensureSettingsButton() {
        let button = document.querySelector(
            "#baidupan-autosave-settings"
        );
        if (button) return button;

        button = document.createElement("button");
        button.id = "baidupan-autosave-settings";
        button.type = "button";
        button.setAttribute(
            "aria-label",
            "Configure Baidu Pan auto-save destination"
        );
        button.textContent = "⚙ Auto-save";
        Object.assign(button.style, {
            position: "fixed",
            right: "18px",
            bottom: "18px",
            zIndex: "2147483647",
            padding: "8px 11px",
            border: "1px solid rgba(255,255,255,.35)",
            borderRadius: "7px",
            color: "#fff",
            background: "#1f2937",
            boxShadow: "0 2px 10px rgba(0,0,0,.25)",
            font: "600 12px/1.4 sans-serif",
            cursor: "pointer",
            opacity: "0.92"
        });
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void configureDestinationPath();
        });

        const parent = document.documentElement || document.body;
        if (!parent) return null;

        parent.appendChild(button);
        void getDestinationPath().then(updateSettingsButtonTitle);
        return button;
    }

    function mountSettingsButton() {
        if (document.body) {
            ensureSettingsButton();
            return;
        }

        document.addEventListener(
            "DOMContentLoaded",
            ensureSettingsButton,
            {once: true}
        );
    }

    function readLocalValue(locals, key) {
        if (!locals) return undefined;

        try {
            if (typeof locals.get === "function") {
                return locals.get(key);
            }
        } catch (_) {
            // Fall through to property access.
        }

        return locals[key];
    }

    function normalizeFileList(value) {
        if (!value) return [];

        if (typeof value === "string") {
            try {
                value = JSON.parse(value);
            } catch (_) {
                return [];
            }
        }

        return Array.isArray(value) ? value : [value];
    }

    function buildShareContext(data) {
        if (!data) return null;

        let files = normalizeFileList(data.FILEINFO || data.file_list);

        if (!files.length && (data.FS_ID || data.fs_id)) {
            files = [{
                fs_id: data.FS_ID || data.fs_id,
                path: data.PATH || data.path,
                server_filename: data.FILENAME || data.filename
            }];
        }

        const context = {
            shareId: data.SHARE_ID || data.shareid,
            shareUk: data.SHARE_UK || data.share_uk,
            bdstoken: data.MYBDSTOKEN || data.bdstoken,
            files
        };

        const hasRequiredData =
            context.shareId &&
            context.shareUk &&
            context.files.some((file) => file && file.fs_id);

        return hasRequiredData ? context : null;
    }

    function getShareContextFromPage() {
        const yunData = pageWindow.yunData || {};
        const locals = pageWindow.locals;

        return buildShareContext({
            ...yunData,
            SHARE_ID:
                yunData.SHARE_ID || readLocalValue(locals, "shareid"),
            SHARE_UK:
                yunData.SHARE_UK || readLocalValue(locals, "share_uk"),
            MYBDSTOKEN:
                yunData.MYBDSTOKEN || readLocalValue(locals, "bdstoken"),
            FILEINFO:
                yunData.FILEINFO ||
                yunData.file_list ||
                readLocalValue(locals, "file_list")
        });
    }

    function getSharePageUrl() {
        const url = new URL(location.href);
        const shareKey = url.searchParams.get("surl");

        if (shareKey) {
            return `${location.origin}/s/1${shareKey}`;
        }

        return location.href;
    }

    function extractLocalsData(html) {
        const markerIndex = html.indexOf("locals.mset(");
        if (markerIndex < 0) return null;

        const objectStart = html.indexOf("{", markerIndex);
        if (objectStart < 0) return null;

        let depth = 0;
        let insideString = false;
        let escaped = false;

        for (let index = objectStart; index < html.length; index += 1) {
            const character = html[index];

            if (insideString) {
                if (escaped) {
                    escaped = false;
                } else if (character === "\\") {
                    escaped = true;
                } else if (character === '"') {
                    insideString = false;
                }
                continue;
            }

            if (character === '"') {
                insideString = true;
            } else if (character === "{") {
                depth += 1;
            } else if (character === "}") {
                depth -= 1;

                if (depth === 0) {
                    let json = html.slice(objectStart, index + 1);

                    json = json.replace(
                        /(\"fs_id\"\s*:\s*)(\d{16,})/g,
                        '$1"$2"'
                    );

                    try {
                        return JSON.parse(json);
                    } catch (error) {
                        console.warn(
                            "[Baidu Pan Auto-Save] Could not parse share metadata",
                            error
                        );
                        return null;
                    }
                }
            }
        }

        return null;
    }

    async function getShareContextFromHtml() {
        const response = await fetch(getSharePageUrl(), {
            credentials: "include",
            cache: "no-store"
        });

        if (!response.ok) return null;

        const html = await response.text();
        return buildShareContext(extractLocalsData(html));
    }

    async function waitForShareContext(timeoutMilliseconds = 90000) {
        const deadline = Date.now() + timeoutMilliseconds;
        let nextHtmlCheck = 0;

        while (Date.now() < deadline) {
            const context = getShareContextFromPage();
            if (context) return context;

            if (Date.now() >= nextHtmlCheck) {
                try {
                    const htmlContext = await getShareContextFromHtml();
                    if (htmlContext) return htmlContext;
                } catch (error) {
                    console.debug(
                        "[Baidu Pan Auto-Save] Share metadata is not ready",
                        error
                    );
                }
                nextHtmlCheck = Date.now() + 2500;
            }

            await sleep(300);
        }

        return null;
    }

    function parseRetryAfter(response) {
        const header = response.headers.get("Retry-After");
        if (!header) return 0;

        const seconds = Number(header);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

        const date = Date.parse(header);
        return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
    }

    async function baiduRequest(path, options = {}) {
        let response;

        try {
            response = await fetch(path, {
                credentials: "include",
                headers: {
                    "X-Requested-With": "XMLHttpRequest",
                    ...(options.body
                        ? {
                            "Content-Type":
                                "application/x-www-form-urlencoded; charset=UTF-8"
                        }
                        : {})
                },
                ...options
            });
        } catch (error) {
            error.transient = true;
            throw error;
        }

        if (!response.ok) {
            const error = new Error(
                `Baidu request failed: HTTP ${response.status}`
            );
            error.httpStatus = response.status;
            error.retryAfterMilliseconds = parseRetryAfter(response);
            error.transient =
                response.status === 408 ||
                response.status === 409 ||
                response.status === 425 ||
                response.status === 429 ||
                response.status >= 500;
            throw error;
        }

        try {
            return await response.json();
        } catch (error) {
            error.transient = true;
            throw error;
        }
    }

    function createBaiduApiError(result, fallbackMessage) {
        const message =
            result && (result.show_msg || result.errmsg) ||
            fallbackMessage ||
            `Baidu API error ${result && result.errno}`;
        const error = new Error(message);
        error.errno = result && result.errno;
        return error;
    }

    function isRetryableError(error) {
        if (!error) return false;
        if (typeof error.transient === "boolean") return error.transient;

        const message = String(error.message || "").toLowerCase();
        const permanentPattern =
            /sign in|登录|不存在|已取消|失效|无权限|permission|容量不足|space|invalid (?:share|path)|文件名/;

        return !permanentPattern.test(message);
    }

    function getRetryDelayMilliseconds(error, failedAttemptIndex) {
        if (error && error.retryAfterMilliseconds > 0) {
            return Math.min(
                Math.max(
                    error.retryAfterMilliseconds,
                    MINIMUM_WRITE_INTERVAL_MILLISECONDS
                ),
                RETRY_MAX_DELAY_MILLISECONDS
            );
        }

        const exponential = Math.min(
            RETRY_BASE_DELAY_MILLISECONDS * (2 ** failedAttemptIndex),
            RETRY_MAX_DELAY_MILLISECONDS
        );
        const jitter = Math.floor(Math.random() * 750);
        return exponential + jitter;
    }

    function readStorageNumber(key) {
        try {
            return Number(localStorage.getItem(key) || "0") || 0;
        } catch (_) {
            return 0;
        }
    }

    function writeStorageValue(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch (_) {
            // Continue without cross-tab persistence when storage is blocked.
        }
    }

    async function waitForSharedWriteSlot() {
        const now = Date.now();
        const lastWrite = readStorageNumber(LAST_WRITE_KEY);
        const cooldownUntil = readStorageNumber(COOLDOWN_UNTIL_KEY);
        const nextWrite = Math.max(
            lastWrite + MINIMUM_WRITE_INTERVAL_MILLISECONDS,
            cooldownUntil
        );

        if (nextWrite > now) {
            await sleep(nextWrite - now + Math.floor(Math.random() * 250));
        }

        writeStorageValue(LAST_WRITE_KEY, Date.now());
    }

    function extendSharedCooldown(delayMilliseconds) {
        const requestedCooldown = Date.now() + delayMilliseconds;
        const existingCooldown = readStorageNumber(COOLDOWN_UNTIL_KEY);

        if (requestedCooldown > existingCooldown) {
            writeStorageValue(COOLDOWN_UNTIL_KEY, requestedCooldown);
        }
    }

    async function runWithRetry(label, operation, maximumAttempts) {
        let lastError;

        for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
            try {
                return await operation(attempt);
            } catch (error) {
                lastError = error;

                if (
                    attempt === maximumAttempts - 1 ||
                    !isRetryableError(error)
                ) {
                    throw error;
                }

                const delay = getRetryDelayMilliseconds(error, attempt);
                extendSharedCooldown(delay);
                const seconds = Math.ceil(delay / 1000);
                showStatus(
                    `${label} failed; retrying in ${seconds}s ` +
                    `(${attempt + 2}/${maximumAttempts})…`,
                    true
                );
                console.warn(
                    `[Baidu Pan Auto-Save] ${label} attempt ` +
                    `${attempt + 1}/${maximumAttempts} failed`,
                    error
                );
                await sleep(delay);
            }
        }

        throw lastError;
    }

    async function getBdstoken(existingToken) {
        if (existingToken && existingToken !== "null") {
            return existingToken;
        }

        const query = new URLSearchParams({
            fields: JSON.stringify(["bdstoken"])
        });

        const result = await runWithRetry(
            "Reading account token",
            () => baiduRequest(`/api/gettemplatevariable?${query.toString()}`),
            4
        );
        const token = result && result.result && result.result.bdstoken;

        if (!token || token === "null") {
            const error = new Error("Sign in to your Baidu Pan account first");
            error.transient = false;
            throw error;
        }

        return token;
    }

    function destinationAncestors(path) {
        if (path === "/") return [];

        const segments = path.split("/").filter(Boolean);
        return segments.map(
            (_, index) => `/${segments.slice(0, index + 1).join("/")}`
        );
    }

    async function inspectDestinationFolder(path, bdstoken) {
        const listQuery = new URLSearchParams({
            order: "time",
            desc: "1",
            showempty: "0",
            page: "1",
            num: "1",
            dir: path,
            bdstoken
        });

        return baiduRequest(`/api/list?${listQuery.toString()}`);
    }

    async function createDestinationFolder(path, bdstoken) {
        const createQuery = new URLSearchParams({
            a: "commit",
            bdstoken
        });
        const createBody = new URLSearchParams({
            path,
            isdir: "1",
            block_list: "[]"
        });

        await waitForSharedWriteSlot();
        return baiduRequest(
            `/api/create?${createQuery.toString()}`,
            {
                method: "POST",
                body: createBody
            }
        );
    }

    async function ensureDestinationFolder(path, bdstoken) {
        for (const folderPath of destinationAncestors(path)) {
            const listResult = await runWithRetry(
                `Checking ${folderPath}`,
                async () => {
                    const result = await inspectDestinationFolder(
                        folderPath,
                        bdstoken
                    );

                    if (result.errno !== 0 && result.errno !== -9) {
                        throw createBaiduApiError(
                            result,
                            `Unable to inspect ${folderPath}: ` +
                            `errno ${result.errno}`
                        );
                    }

                    return result;
                },
                4
            );

            if (listResult.errno === 0) continue;

            const createResult = await runWithRetry(
                `Creating ${folderPath}`,
                async () => {
                    const result = await createDestinationFolder(
                        folderPath,
                        bdstoken
                    );

                    if (result.errno !== 0 && result.errno !== -8) {
                        throw createBaiduApiError(
                            result,
                            `Unable to create ${folderPath}: ` +
                            `errno ${result.errno}`
                        );
                    }

                    return result;
                },
                4
            );
            console.debug(
                `[Baidu Pan Auto-Save] Destination ready: ${folderPath}`,
                createResult
            );
        }
    }

    async function transferBatch(context, bdstoken, fsids, destinationPath) {
        const query = new URLSearchParams({
            shareid: String(context.shareId),
            from: String(context.shareUk),
            ondup: "skip",
            channel: "chunlei",
            web: "1",
            clienttype: "0",
            app_id: "250528",
            bdstoken
        });
        const body = new URLSearchParams({
            fsidlist: JSON.stringify(fsids.map(String)),
            path: destinationPath
        });

        await waitForSharedWriteSlot();
        const result = await baiduRequest(
            `/share/transfer?${query.toString()}`,
            {
                method: "POST",
                body
            }
        );

        if (result.errno !== 0) {
            throw createBaiduApiError(
                result,
                `Baidu transfer error ${result.errno}`
            );
        }
    }

    async function transferBatchWithRetry(
        context,
        bdstoken,
        fsids,
        destinationPath,
        batchNumber,
        batchCount
    ) {
        return runWithRetry(
            `Saving batch ${batchNumber}/${batchCount}`,
            () => transferBatch(
                context,
                bdstoken,
                fsids,
                destinationPath
            ),
            TRANSFER_MAX_ATTEMPTS
        );
    }

    function readJsonStorage(key) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : null;
        } catch (_) {
            return null;
        }
    }

    function removeStorageValue(key) {
        try {
            localStorage.removeItem(key);
        } catch (_) {
            // Ignore unavailable storage.
        }
    }

    async function withFallbackLeaseLock(task) {
        const lockToken = `${OWNER_ID}-${Math.random().toString(36).slice(2)}`;
        let lastQueueNotice = 0;

        while (true) {
            const now = Date.now();
            const existingLock = readJsonStorage(FALLBACK_LOCK_KEY);

            if (!existingLock || existingLock.expiresAt <= now) {
                writeStorageValue(
                    FALLBACK_LOCK_KEY,
                    JSON.stringify({
                        token: lockToken,
                        expiresAt:
                            now + FALLBACK_LOCK_LEASE_MILLISECONDS
                    })
                );

                await sleep(80 + Math.floor(Math.random() * 120));
                const confirmedLock = readJsonStorage(FALLBACK_LOCK_KEY);

                if (confirmedLock && confirmedLock.token === lockToken) {
                    const heartbeat = setInterval(() => {
                        const currentLock = readJsonStorage(FALLBACK_LOCK_KEY);
                        if (!currentLock || currentLock.token !== lockToken) {
                            return;
                        }

                        writeStorageValue(
                            FALLBACK_LOCK_KEY,
                            JSON.stringify({
                                token: lockToken,
                                expiresAt:
                                    Date.now() +
                                    FALLBACK_LOCK_LEASE_MILLISECONDS
                            })
                        );
                    }, Math.floor(FALLBACK_LOCK_LEASE_MILLISECONDS / 3));

                    try {
                        return await task();
                    } finally {
                        clearInterval(heartbeat);
                        const currentLock = readJsonStorage(FALLBACK_LOCK_KEY);
                        if (currentLock && currentLock.token === lockToken) {
                            removeStorageValue(FALLBACK_LOCK_KEY);
                        }
                    }
                }
            }

            if (now - lastQueueNotice > 10000) {
                showStatus(
                    "Queued behind another Baidu Pan auto-save tab…"
                );
                lastQueueNotice = now;
            }

            await sleep(600 + Math.floor(Math.random() * 500));
        }
    }

    async function withGlobalTransferLock(task) {
        if (
            navigator.locks &&
            typeof navigator.locks.request === "function"
        ) {
            return navigator.locks.request(
                GLOBAL_LOCK_NAME,
                {mode: "exclusive"},
                task
            );
        }

        return withFallbackLeaseLock(task);
    }

    function hashString(value) {
        let hash = 0x811c9dc5;

        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }

        return (hash >>> 0).toString(16).padStart(8, "0");
    }

    function buildJobIdentity(context, fsids, destinationPath) {
        const signature = JSON.stringify({
            shareId: String(context.shareId),
            fsids: fsids.map(String),
            destinationPath
        });

        return {
            key: `${JOB_KEY_PREFIX}${hashString(signature)}`,
            signature
        };
    }

    function isJobComplete(jobIdentity) {
        const record = readJsonStorage(jobIdentity.key);
        return Boolean(
            record &&
            record.status === "done" &&
            record.signature === jobIdentity.signature
        );
    }

    function markJobComplete(jobIdentity) {
        writeStorageValue(
            jobIdentity.key,
            JSON.stringify({
                status: "done",
                signature: jobIdentity.signature,
                completedAt: new Date().toISOString()
            })
        );
    }

    function showStatus(message, failed = false) {
        let element = document.querySelector(
            "#baidupan-autosave-status"
        );

        if (!element) {
            element = document.createElement("div");
            element.id = "baidupan-autosave-status";
            element.title =
                "Use the userscript manager menu to change the destination.";
            Object.assign(element.style, {
                position: "fixed",
                right: "18px",
                bottom: "64px",
                zIndex: "2147483647",
                maxWidth: "360px",
                padding: "9px 13px",
                borderRadius: "6px",
                color: "#fff",
                font: "13px/1.4 sans-serif",
                boxShadow: "0 2px 10px rgba(0,0,0,.25)"
            });

            const parent = document.documentElement || document.body;
            if (!parent) {
                console.info(`[Baidu Pan Auto-Save] ${message}`);
                return;
            }
            parent.appendChild(element);
        }

        element.style.background = failed ? "#c0392b" : "#2878ff";
        element.textContent = message;
    }

    function closeTabAfterSuccess() {
        if (!AUTO_CLOSE_AFTER_SUCCESS) return;

        setTimeout(() => {
            window.close();

            setTimeout(() => {
                if (!window.closed) {
                    showStatus(
                        "Saved successfully. The browser blocked automatic tab closing.",
                        true
                    );
                }
            }, 500);
        }, AUTO_CLOSE_DELAY_MILLISECONDS);
    }

    async function processTransferJob(
        context,
        fsids,
        destinationPath,
        jobIdentity
    ) {
        if (isJobComplete(jobIdentity)) {
            showStatus(
                `Already saved to ${destinationPath}; closing this tab…`
            );
            return;
        }

        showStatus(
            `Saving ${fsids.length} item(s) to ${destinationPath}…`
        );
        const bdstoken = await getBdstoken(context.bdstoken);
        await ensureDestinationFolder(destinationPath, bdstoken);

        const batchCount = Math.ceil(fsids.length / TRANSFER_BATCH_SIZE);
        for (
            let index = 0, batchNumber = 1;
            index < fsids.length;
            index += TRANSFER_BATCH_SIZE, batchNumber += 1
        ) {
            await transferBatchWithRetry(
                context,
                bdstoken,
                fsids.slice(index, index + TRANSFER_BATCH_SIZE),
                destinationPath,
                batchNumber,
                batchCount
            );
        }

        markJobComplete(jobIdentity);
        showStatus(`Saved to ${destinationPath}; closing this tab…`);
    }

    async function autoSaveCurrentShare() {
        const destinationPath = await getDestinationPath();
        const context = await waitForShareContext();

        if (!context) {
            showStatus(
                "Auto-save could not read this share. Open the console for details.",
                true
            );
            return;
        }

        const fsids = context.files
            .map((file) => file && file.fs_id)
            .filter(Boolean);

        if (!fsids.length) return;

        const jobIdentity = buildJobIdentity(
            context,
            fsids,
            destinationPath
        );

        try {
            showStatus(
                `Queued to save ${fsids.length} item(s) to ` +
                `${destinationPath}…`
            );
            await withGlobalTransferLock(
                () => processTransferJob(
                    context,
                    fsids,
                    destinationPath,
                    jobIdentity
                )
            );
            closeTabAfterSuccess();
        } catch (error) {
            console.error(
                "[Baidu Pan Auto-Save] Automatic transfer failed:",
                error
            );
            showStatus(`Automatic save failed: ${error.message}`, true);
        }
    }

    const testMode = Boolean(
        typeof globalThis !== "undefined" &&
        globalThis.__BAIDUPAN_AUTOSAVE_TEST_MODE__
    );

    if (testMode) {
        globalThis.__BAIDUPAN_AUTOSAVE_TEST_API__ = Object.freeze({
            normalizeDestinationPath,
            destinationAncestors,
            isRetryableError,
            getRetryDelayMilliseconds,
            buildJobIdentity,
            withGlobalTransferLock,
            ensureSettingsButton
        });
        return;
    }

    registerSettingsMenu();
    mountSettingsButton();

    if (isPotentialSharePage()) {
        void autoSaveCurrentShare();
    }
})();
