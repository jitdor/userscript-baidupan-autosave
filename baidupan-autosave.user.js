// ==UserScript==
// @name         Baidu Pan Auto-Save
// @namespace    https://github.com/jitdor/userscript-baidupan-autosave
// @version      1.0.5
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
    const REQUEST_TIMEOUT_MILLISECONDS = 25000;
    const MINIMUM_WRITE_INTERVAL_MILLISECONDS = 2500;
    const GLOBAL_LOCK_NAME = "baidupan-autosave-transfer-v1";
    const FALLBACK_LOCK_KEY = "baidupan-autosave:transfer-lock-v1";
    const FALLBACK_LOCK_LEASE_MILLISECONDS = 15000;
    const LAST_WRITE_KEY = "baidupan-autosave:last-write-v1";
    const COOLDOWN_UNTIL_KEY = "baidupan-autosave:cooldown-until-v1";
    const JOB_KEY_PREFIX = "baidupan-autosave:job-v3:";
    const QUEUE_ENTRY_PREFIX = "baidupan-autosave:queue-entry-v1:";
    const QUEUE_TERMINAL_RETENTION_MILLISECONDS = 120000;
    const QUEUE_STALE_MILLISECONDS = 600000;
    const QUEUE_PANEL_REFRESH_MILLISECONDS = 1000;
    const NAVIGATION_LOCK_NAME =
        "baidupan-autosave-navigation-state-v1";
    const NAVIGATION_LOCK_KEY =
        "baidupan-autosave:navigation-state-lock-v1";
    const NAVIGATION_SEQUENCE_KEY =
        "baidupan-autosave:navigation-sequence-v1";
    const NAVIGATION_QUEUE_PREFIX =
        "baidupan-autosave:navigation-queue-v1:";
    const NAVIGATION_SLOT_PREFIX =
        "baidupan-autosave:navigation-slot-v1:";
    const NAVIGATION_SESSION_KEY =
        "baidupan-autosave:navigation-session-v1";
    const NAVIGATION_SECOND_LANE_DELAY_MILLISECONDS = 10000;
    const NAVIGATION_SLOT_LEASE_MILLISECONDS = 30000;
    const NAVIGATION_SLOT_HEARTBEAT_MILLISECONDS = 5000;
    const NAVIGATION_QUEUE_STALE_MILLISECONDS = 900000;
    const NAVIGATION_POLL_MILLISECONDS = 250;
    const OWNER_ID =
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const pageWindow =
        typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const currentQueueEntryKey = `${QUEUE_ENTRY_PREFIX}${OWNER_ID}`;
    let queuePanelRefreshTimer = null;
    let queueListenersRegistered = false;
    let navigationHeartbeatTimer = null;

    const sleep = (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds));

    async function fetchWithTimeout(
        resource,
        options = {},
        timeoutMilliseconds = REQUEST_TIMEOUT_MILLISECONDS,
        responseHandler = (response) => response
    ) {
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            timeoutMilliseconds
        );

        try {
            const response = await fetch(resource, {
                ...options,
                signal: controller.signal
            });
            return await responseHandler(response);
        } catch (error) {
            if (controller.signal.aborted) {
                const timeoutError = new Error(
                    `Baidu request timed out after ` +
                    `${Math.ceil(timeoutMilliseconds / 1000)}s`
                );
                timeoutError.name = "TimeoutError";
                timeoutError.transient = true;
                throw timeoutError;
            }

            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    function isPotentialSharePage() {
        const url = new URL(location.href);

        return (
            location.pathname.startsWith("/s/") ||
            location.pathname.startsWith("/share/") ||
            url.searchParams.has("surl") ||
            url.searchParams.has("shareid")
        );
    }

    function readNavigationSession() {
        try {
            const value = sessionStorage.getItem(NAVIGATION_SESSION_KEY);
            return value ? JSON.parse(value) : null;
        } catch (_) {
            return null;
        }
    }

    function writeNavigationSession(value) {
        try {
            sessionStorage.setItem(
                NAVIGATION_SESSION_KEY,
                JSON.stringify(value)
            );
        } catch (_) {
            // The tab can still use its in-memory owner ID without persistence.
        }
    }

    function getNavigationTabId() {
        const session = readNavigationSession();
        if (session && session.tabId) return session.tabId;

        const tabId =
            `${Date.now().toString(36)}-` +
            `${Math.random().toString(36).slice(2)}`;
        writeNavigationSession({tabId});
        return tabId;
    }

    function navigationQueueKey(tabId) {
        return `${NAVIGATION_QUEUE_PREFIX}${tabId}`;
    }

    function navigationSlotKey(lane) {
        return `${NAVIGATION_SLOT_PREFIX}${lane}`;
    }

    function readNavigationSlot(lane) {
        return readJsonStorage(navigationSlotKey(lane));
    }

    function isNavigationSlotLive(slot, now = Date.now()) {
        return Boolean(slot && Number(slot.expiresAt || 0) > now);
    }

    function listNavigationRequests(now = Date.now()) {
        const requests = [];

        try {
            for (
                let index = localStorage.length - 1;
                index >= 0;
                index -= 1
            ) {
                const key = localStorage.key(index);
                if (!key || !key.startsWith(NAVIGATION_QUEUE_PREFIX)) {
                    continue;
                }

                const request = readJsonStorage(key);
                const age =
                    now - Number(
                        request && (
                            request.updatedAt ||
                            request.enqueuedAt
                        )
                    );

                if (
                    !request ||
                    !Number.isFinite(age) ||
                    age > NAVIGATION_QUEUE_STALE_MILLISECONDS
                ) {
                    removeStorageValue(key);
                    continue;
                }

                requests.push(request);
            }
        } catch (_) {
            return [];
        }

        return requests.sort(
            (left, right) =>
                Number(left.sequence) - Number(right.sequence) ||
                Number(left.enqueuedAt) - Number(right.enqueuedAt) ||
                String(left.tabId).localeCompare(String(right.tabId))
        );
    }

    function cleanupNavigationState(now = Date.now()) {
        for (let lane = 0; lane < 2; lane += 1) {
            const slot = readNavigationSlot(lane);
            if (slot && !isNavigationSlotLive(slot, now)) {
                removeStorageValue(navigationSlotKey(lane));
                removeStorageValue(navigationQueueKey(slot.tabId));
            }
        }

        return listNavigationRequests(now);
    }

    function registerNavigationRequest(tabId, now = Date.now()) {
        const existing = readJsonStorage(navigationQueueKey(tabId));
        if (existing) {
            const next = {...existing, updatedAt: now};
            writeStorageValue(
                navigationQueueKey(tabId),
                JSON.stringify(next)
            );
            return next;
        }

        const requests = cleanupNavigationState(now);
        const liveSlots = [0, 1]
            .map(readNavigationSlot)
            .filter((slot) => isNavigationSlotLive(slot, now));
        let sequenceState = readJsonStorage(NAVIGATION_SEQUENCE_KEY);

        if (!requests.length && !liveSlots.length) {
            sequenceState = {
                nextSequence: 0,
                burstStartedAt: now
            };
        } else if (!sequenceState) {
            const highestSequence = requests.reduce(
                (highest, request) =>
                    Math.max(highest, Number(request.sequence || 0)),
                -1
            );
            sequenceState = {
                nextSequence: highestSequence + 1,
                burstStartedAt: now
            };
        }

        const sequence = Number(sequenceState.nextSequence || 0);
        const lane = sequence % 2;
        const request = {
            tabId,
            sequence,
            lane,
            enqueuedAt: now,
            updatedAt: now,
            notBefore:
                sequence === 1
                    ? Number(sequenceState.burstStartedAt) +
                        NAVIGATION_SECOND_LANE_DELAY_MILLISECONDS
                    : now
        };

        writeStorageValue(
            navigationQueueKey(tabId),
            JSON.stringify(request)
        );
        writeStorageValue(
            NAVIGATION_SEQUENCE_KEY,
            JSON.stringify({
                nextSequence: sequence + 1,
                burstStartedAt: Number(sequenceState.burstStartedAt)
            })
        );
        return request;
    }

    function tryClaimNavigationSlot(tabId, now = Date.now()) {
        cleanupNavigationState(now);
        const request = readJsonStorage(navigationQueueKey(tabId));
        if (!request) return null;

        const existingSlot = readNavigationSlot(request.lane);
        if (
            isNavigationSlotLive(existingSlot, now) &&
            existingSlot.tabId === tabId
        ) {
            const renewedSlot = {
                ...existingSlot,
                heartbeatAt: now,
                expiresAt: now + NAVIGATION_SLOT_LEASE_MILLISECONDS
            };
            writeStorageValue(
                navigationSlotKey(request.lane),
                JSON.stringify(renewedSlot)
            );
            return renewedSlot;
        }

        if (isNavigationSlotLive(existingSlot, now)) return null;
        if (now < Number(request.notBefore || 0)) return null;

        const firstForLane = listNavigationRequests(now).find(
            (candidate) => Number(candidate.lane) === Number(request.lane)
        );
        if (!firstForLane || firstForLane.tabId !== tabId) return null;

        const slot = {
            tabId,
            lane: Number(request.lane),
            sequence: Number(request.sequence),
            acquiredAt: now,
            heartbeatAt: now,
            expiresAt: now + NAVIGATION_SLOT_LEASE_MILLISECONDS
        };
        writeStorageValue(
            navigationSlotKey(request.lane),
            JSON.stringify(slot)
        );

        const confirmed = readNavigationSlot(request.lane);
        return confirmed && confirmed.tabId === tabId
            ? confirmed
            : null;
    }

    function renewNavigationSlot(tabId, now = Date.now()) {
        const session = readNavigationSession();
        const lane = session && Number(session.lane);
        if (lane !== 0 && lane !== 1) return false;

        const slot = readNavigationSlot(lane);
        if (!isNavigationSlotLive(slot, now) || slot.tabId !== tabId) {
            return false;
        }

        writeStorageValue(
            navigationSlotKey(lane),
            JSON.stringify({
                ...slot,
                heartbeatAt: now,
                expiresAt: now + NAVIGATION_SLOT_LEASE_MILLISECONDS
            })
        );
        return true;
    }

    function startNavigationHeartbeat(tabId) {
        if (navigationHeartbeatTimer) {
            clearInterval(navigationHeartbeatTimer);
        }

        navigationHeartbeatTimer = setInterval(() => {
            renewNavigationSlot(tabId);
        }, NAVIGATION_SLOT_HEARTBEAT_MILLISECONDS);
    }

    function resumeOwnedNavigationSlot(now = Date.now()) {
        const session = readNavigationSession();
        if (!session || !session.tabId) return false;
        if (!renewNavigationSlot(session.tabId, now)) return false;

        startNavigationHeartbeat(session.tabId);
        return true;
    }

    function releaseNavigationSlot(tabId = getNavigationTabId()) {
        if (navigationHeartbeatTimer) {
            clearInterval(navigationHeartbeatTimer);
            navigationHeartbeatTimer = null;
        }

        for (let lane = 0; lane < 2; lane += 1) {
            const slot = readNavigationSlot(lane);
            if (slot && slot.tabId === tabId) {
                removeStorageValue(navigationSlotKey(lane));
            }
        }

        removeStorageValue(navigationQueueKey(tabId));
        writeNavigationSession({tabId});
    }

    async function withNavigationStateLock(task) {
        if (
            navigator.locks &&
            typeof navigator.locks.request === "function"
        ) {
            return navigator.locks.request(
                NAVIGATION_LOCK_NAME,
                {mode: "exclusive"},
                task
            );
        }

        return withFallbackLeaseLock(
            NAVIGATION_LOCK_KEY,
            task,
            "Waiting for a Baidu page-load slot…"
        );
    }

    function showNavigationWaiting(request, now = Date.now()) {
        const delay = Math.max(0, Number(request.notBefore || 0) - now);
        const seconds = Math.ceil(delay / 1000);
        const message = delay > 0
            ? `Waiting ${seconds}s before loading this Baidu share…`
            : `Waiting for Baidu loading lane ${Number(request.lane) + 1}…`;

        document.title = message;
        const parent = document.documentElement || document.body;
        if (!parent) return;

        let status = document.querySelector(
            "#baidupan-autosave-navigation-wait"
        );
        if (!status) {
            status = document.createElement("div");
            status.id = "baidupan-autosave-navigation-wait";
            Object.assign(status.style, {
                position: "fixed",
                inset: "0",
                zIndex: "2147483647",
                display: "grid",
                placeItems: "center",
                padding: "24px",
                color: "#fff",
                background: "#111827",
                font: "600 16px/1.5 sans-serif",
                textAlign: "center"
            });
            parent.appendChild(status);
        }
        status.textContent = message;
    }

    async function queueNavigationPageLoad() {
        const tabId = getNavigationTabId();
        let reloadPending = false;
        let pageHidden = false;
        window.addEventListener(
            "pagehide",
            () => {
                pageHidden = true;
                if (!reloadPending) releaseNavigationSlot(tabId);
            },
            {once: true}
        );
        const request = await withNavigationStateLock(
            () => registerNavigationRequest(tabId)
        );
        if (pageHidden) {
            releaseNavigationSlot(tabId);
            return;
        }

        while (true) {
            if (pageHidden) return;
            const now = Date.now();
            showNavigationWaiting(request, now);
            const slot = await withNavigationStateLock(
                () => tryClaimNavigationSlot(tabId)
            );

            if (pageHidden) {
                releaseNavigationSlot(tabId);
                return;
            }
            if (slot) {
                writeNavigationSession({
                    tabId,
                    lane: Number(slot.lane)
                });
                reloadPending = true;
                location.reload();
                return;
            }

            await sleep(NAVIGATION_POLL_MILLISECONDS);
        }
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
            void refreshQueuePanel();
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
                void refreshQueuePanel();
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
            "Click to view the queue or change the destination.";
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
            toggleQueuePanel();
        });

        const parent = document.documentElement || document.body;
        if (!parent) return null;

        parent.appendChild(button);
        void getDestinationPath().then(updateSettingsButtonTitle);
        return button;
    }

    function mountSettingsButton() {
        if (pageWindow.top !== pageWindow.self) return false;

        if (document.body) {
            ensureSettingsButton();
            registerQueueListeners();
            void refreshQueuePanel();
            return true;
        }

        document.addEventListener(
            "DOMContentLoaded",
            () => {
                ensureSettingsButton();
                registerQueueListeners();
                void refreshQueuePanel();
            },
            {once: true}
        );
        return true;
    }

    function registerQueueListeners() {
        if (queueListenersRegistered) return;
        queueListenersRegistered = true;

        window.addEventListener("storage", (event) => {
            if (
                event.key &&
                (
                    event.key.startsWith(QUEUE_ENTRY_PREFIX) ||
                    event.key === LAST_WRITE_KEY ||
                    event.key === COOLDOWN_UNTIL_KEY
                )
            ) {
                void refreshQueuePanel();
            }
        });
    }

    function createPanelAction(label, handler) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        Object.assign(button.style, {
            padding: "6px 9px",
            border: "1px solid rgba(255,255,255,.24)",
            borderRadius: "6px",
            color: "#fff",
            background: "#374151",
            font: "600 11px/1.3 sans-serif",
            cursor: "pointer"
        });
        button.addEventListener("click", handler);
        return button;
    }

    function ensureQueuePanel() {
        let panel = document.querySelector("#baidupan-autosave-queue-panel");
        if (panel) return panel;

        panel = document.createElement("section");
        panel.id = "baidupan-autosave-queue-panel";
        panel.setAttribute("aria-label", "Baidu Pan auto-save queue");
        Object.assign(panel.style, {
            display: "none",
            position: "fixed",
            right: "18px",
            bottom: "64px",
            zIndex: "2147483647",
            width: "min(420px, calc(100vw - 36px))",
            maxHeight: "min(520px, calc(100vh - 100px))",
            overflow: "auto",
            boxSizing: "border-box",
            padding: "14px",
            border: "1px solid rgba(255,255,255,.18)",
            borderRadius: "10px",
            color: "#f9fafb",
            background: "#111827",
            boxShadow: "0 8px 30px rgba(0,0,0,.38)",
            font: "12px/1.45 sans-serif"
        });

        const header = document.createElement("div");
        Object.assign(header.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            marginBottom: "10px"
        });

        const heading = document.createElement("strong");
        heading.textContent = "Baidu Pan Auto-Save Queue";
        heading.style.fontSize = "14px";
        header.appendChild(heading);
        header.appendChild(
            createPanelAction("Close", () => setQueuePanelVisible(false))
        );
        panel.appendChild(header);

        const destinationRow = document.createElement("div");
        destinationRow.style.marginBottom = "9px";
        const destinationLabel = document.createElement("span");
        destinationLabel.textContent = "Destination: ";
        const destinationValue = document.createElement("code");
        destinationValue.id = "baidupan-autosave-queue-destination";
        destinationRow.append(destinationLabel, destinationValue);
        panel.appendChild(destinationRow);

        const actions = document.createElement("div");
        Object.assign(actions.style, {
            display: "flex",
            flexWrap: "wrap",
            gap: "6px",
            marginBottom: "10px"
        });
        actions.append(
            createPanelAction(
                "Change destination",
                () => void configureDestinationPath()
            ),
            createPanelAction("Refresh", () => void refreshQueuePanel()),
            createPanelAction("Clear finished", clearFinishedQueueEntries)
        );
        panel.appendChild(actions);

        const summary = document.createElement("div");
        summary.id = "baidupan-autosave-queue-summary";
        Object.assign(summary.style, {
            marginBottom: "8px",
            color: "#cbd5e1"
        });
        panel.appendChild(summary);

        const list = document.createElement("div");
        list.id = "baidupan-autosave-queue-list";
        panel.appendChild(list);

        const note = document.createElement("div");
        note.textContent =
            "Failed jobs release the write slot while backing off, so other " +
            "tabs can continue.";
        Object.assign(note.style, {
            marginTop: "10px",
            color: "#94a3b8",
            fontSize: "11px"
        });
        panel.appendChild(note);

        const parent = document.body || document.documentElement;
        if (!parent) return null;

        parent.appendChild(panel);
        return panel;
    }

    function setQueuePanelVisible(visible) {
        const panel = ensureQueuePanel();
        if (!panel) return;

        panel.style.display = visible ? "block" : "none";
        if (queuePanelRefreshTimer) {
            clearInterval(queuePanelRefreshTimer);
            queuePanelRefreshTimer = null;
        }

        if (visible) {
            void refreshQueuePanel();
            queuePanelRefreshTimer = setInterval(
                () => void refreshQueuePanel(),
                QUEUE_PANEL_REFRESH_MILLISECONDS
            );
        }
    }

    function toggleQueuePanel() {
        const panel = ensureQueuePanel();
        if (!panel) return;

        setQueuePanelVisible(panel.style.display === "none");
    }

    function clearFinishedQueueEntries() {
        for (const entry of listQueueEntries()) {
            if (isTerminalQueueState(entry.state)) {
                removeStorageValue(`${QUEUE_ENTRY_PREFIX}${entry.id}`);
            }
        }
        void refreshQueuePanel();
    }

    function clearElement(element) {
        while (element && element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }

    function renderQueueEntries(list, entries, now) {
        clearElement(list);

        if (!entries.length) {
            const empty = document.createElement("div");
            empty.textContent = "No recent save jobs.";
            empty.style.color = "#94a3b8";
            list.appendChild(empty);
            return;
        }

        entries.slice(0, 25).forEach((entry, index) => {
            const row = document.createElement("div");
            Object.assign(row.style, {
                padding: "8px 0",
                borderTop:
                    index === 0
                        ? "1px solid rgba(255,255,255,.12)"
                        : "1px solid rgba(255,255,255,.08)"
            });

            const title = document.createElement("div");
            const elapsed = formatElapsed(
                now - Number(entry.enqueuedAt || now)
            );
            title.textContent =
                `#${index + 1} ${(entry.state || "queued").toUpperCase()} ` +
                `• ${elapsed} • ${entry.itemCount || "?"} item(s)`;
            Object.assign(title.style, {
                fontWeight: "700",
                color:
                    entry.state === "failed"
                        ? "#fca5a5"
                        : entry.state === "done"
                            ? "#86efac"
                            : entry.state === "retrying"
                                ? "#fcd34d"
                                : "#f9fafb"
            });
            row.appendChild(title);

            const detail = document.createElement("div");
            detail.textContent =
                `${entry.detail || "Waiting"} → ` +
                `${entry.destinationPath || "destination pending"}`;
            Object.assign(detail.style, {
                marginTop: "2px",
                color: "#cbd5e1",
                overflowWrap: "anywhere"
            });
            row.appendChild(detail);
            list.appendChild(row);
        });
    }

    function updateQueueButtonBadge(entries) {
        const button = document.querySelector(
            "#baidupan-autosave-settings"
        );
        if (!button) return;

        const activeCount = entries.filter(
            (entry) => !isTerminalQueueState(entry.state)
        ).length;
        button.textContent =
            activeCount > 0
                ? `⚙ Auto-save (${activeCount})`
                : "⚙ Auto-save";
    }

    async function refreshQueuePanel() {
        const entries = listQueueEntries();
        updateQueueButtonBadge(entries);

        const panel = document.querySelector(
            "#baidupan-autosave-queue-panel"
        );
        if (!panel || panel.style.display === "none") return;

        const destination = await getDestinationPath();
        const destinationElement = document.querySelector(
            "#baidupan-autosave-queue-destination"
        );
        if (destinationElement) destinationElement.textContent = destination;

        let heldWrites = 0;
        let pendingWrites = 0;
        try {
            if (navigator.locks && typeof navigator.locks.query === "function") {
                const lockState = await navigator.locks.query();
                heldWrites = lockState.held.filter(
                    (lock) => lock.name === GLOBAL_LOCK_NAME
                ).length;
                pendingWrites = lockState.pending.filter(
                    (lock) => lock.name === GLOBAL_LOCK_NAME
                ).length;
            }
        } catch (_) {
            // The queue entries remain useful if lock inspection is blocked.
        }

        const summary = document.querySelector(
            "#baidupan-autosave-queue-summary"
        );
        if (summary) {
            const activeCount = entries.filter(
                (entry) => !isTerminalQueueState(entry.state)
            ).length;
            summary.textContent =
                `${activeCount} active • write slot ` +
                `${heldWrites ? "busy" : "idle"} • ` +
                `${pendingWrites} waiting for the slot`;
        }

        const list = document.querySelector("#baidupan-autosave-queue-list");
        if (list) renderQueueEntries(list, entries, Date.now());
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
        return fetchWithTimeout(
            getSharePageUrl(),
            {
                credentials: "include",
                cache: "no-store"
            },
            REQUEST_TIMEOUT_MILLISECONDS,
            async (response) => {
                if (!response.ok) return null;

                const html = await response.text();
                return buildShareContext(extractLocalsData(html));
            }
        );
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
        try {
            return await fetchWithTimeout(
                path,
                {
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
                },
                REQUEST_TIMEOUT_MILLISECONDS,
                async (response) => {
                    if (!response.ok) {
                        const error = new Error(
                            `Baidu request failed: HTTP ${response.status}`
                        );
                        error.httpStatus = response.status;
                        error.retryAfterMilliseconds =
                            parseRetryAfter(response);
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
            );
        } catch (error) {
            if (typeof error.transient !== "boolean") {
                error.transient = true;
            }
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

    function isExtractionCodeError(error) {
        return Boolean(
            error &&
            String(error.message || "").includes("提取码输入错误")
        );
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

    async function performGlobalWrite(label, operation) {
        updateQueueEntry({
            state: "queued",
            detail: `Waiting for write slot: ${label}`
        });

        return withGlobalTransferLock(async () => {
            updateQueueEntry({
                state: "working",
                detail: label
            });
            await waitForSharedWriteSlot();
            return operation();
        });
    }

    async function runWithRetry(label, operation, maximumAttempts) {
        let lastError;

        for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
            try {
                updateQueueEntry({
                    state: "working",
                    detail:
                        `${label} (${attempt + 1}/${maximumAttempts})`,
                    attempt: attempt + 1,
                    maximumAttempts
                });
                return await operation(attempt);
            } catch (error) {
                lastError = error;

                if (isExtractionCodeError(error)) {
                    updateQueueEntry({
                        state: "retrying",
                        detail:
                            `${label} failed; extraction code is invalid, ` +
                            "reloading page…",
                        lastError: String(error.message || error)
                    });
                    showStatus(
                        "Extraction code is invalid; reloading page…",
                        true
                    );
                    console.warn(
                        `[Baidu Pan Auto-Save] ${label} failed: ` +
                        "extraction code is invalid; reloading the page",
                        error
                    );
                    location.reload();
                    throw error;
                }

                if (
                    attempt === maximumAttempts - 1 ||
                    !isRetryableError(error)
                ) {
                    throw error;
                }

                const delay = getRetryDelayMilliseconds(error, attempt);
                if (
                    error.retryAfterMilliseconds > 0 ||
                    error.httpStatus === 429
                ) {
                    extendSharedCooldown(delay);
                }
                const seconds = Math.ceil(delay / 1000);
                updateQueueEntry({
                    state: "retrying",
                    detail:
                        `${label} failed; retrying in ${seconds}s`,
                    attempt: attempt + 1,
                    maximumAttempts,
                    retryAt: Date.now() + delay,
                    lastError: String(error.message || error)
                });
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

        return performGlobalWrite(
            `Creating ${path}`,
            () => baiduRequest(
                `/api/create?${createQuery.toString()}`,
                {
                    method: "POST",
                    body: createBody
                }
            )
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

        const result = await performGlobalWrite(
            `Saving ${fsids.length} item(s)`,
            () => baiduRequest(
                `/share/transfer?${query.toString()}`,
                {
                    method: "POST",
                    body
                }
            )
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

    function isTerminalQueueState(state) {
        return state === "done" || state === "failed";
    }

    function updateQueueEntry(patch) {
        const current = readJsonStorage(currentQueueEntryKey) || {
            id: OWNER_ID,
            enqueuedAt: Date.now()
        };
        const next = {
            ...current,
            ...patch,
            updatedAt: Date.now()
        };

        writeStorageValue(currentQueueEntryKey, JSON.stringify(next));
        void refreshQueuePanel();
        return next;
    }

    function removeCurrentQueueEntry() {
        removeStorageValue(currentQueueEntryKey);
        void refreshQueuePanel();
    }

    function listQueueEntries(now = Date.now()) {
        const entries = [];

        try {
            for (let index = localStorage.length - 1; index >= 0; index -= 1) {
                const key = localStorage.key(index);
                if (!key || !key.startsWith(QUEUE_ENTRY_PREFIX)) continue;

                const entry = readJsonStorage(key);
                if (!entry) {
                    removeStorageValue(key);
                    continue;
                }

                const age = now - Number(entry.updatedAt || entry.enqueuedAt);
                const retention = isTerminalQueueState(entry.state)
                    ? QUEUE_TERMINAL_RETENTION_MILLISECONDS
                    : QUEUE_STALE_MILLISECONDS;

                if (age > retention) {
                    removeStorageValue(key);
                    continue;
                }

                entries.push(entry);
            }
        } catch (_) {
            return [];
        }

        return entries.sort(
            (left, right) =>
                Number(left.enqueuedAt || 0) -
                Number(right.enqueuedAt || 0)
        );
    }

    function formatElapsed(milliseconds) {
        const seconds = Math.max(0, Math.floor(milliseconds / 1000));
        if (seconds < 60) return `${seconds}s`;

        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;

        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m`;
    }

    async function withFallbackLeaseLock(
        lockKey,
        task,
        waitingMessage
    ) {
        const lockToken = `${OWNER_ID}-${Math.random().toString(36).slice(2)}`;
        let lastQueueNotice = 0;

        while (true) {
            const now = Date.now();
            const existingLock = readJsonStorage(lockKey);

            if (!existingLock || existingLock.expiresAt <= now) {
                writeStorageValue(
                    lockKey,
                    JSON.stringify({
                        token: lockToken,
                        expiresAt:
                            now + FALLBACK_LOCK_LEASE_MILLISECONDS
                    })
                );

                await sleep(80 + Math.floor(Math.random() * 120));
                const confirmedLock = readJsonStorage(lockKey);

                if (confirmedLock && confirmedLock.token === lockToken) {
                    const heartbeat = setInterval(() => {
                        const currentLock = readJsonStorage(lockKey);
                        if (!currentLock || currentLock.token !== lockToken) {
                            return;
                        }

                        writeStorageValue(
                            lockKey,
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
                        const currentLock = readJsonStorage(lockKey);
                        if (currentLock && currentLock.token === lockToken) {
                            removeStorageValue(lockKey);
                        }
                    }
                }
            }

            if (now - lastQueueNotice > 10000) {
                showStatus(waitingMessage);
                updateQueueEntry({
                    state: "queued",
                    detail: waitingMessage
                });
                lastQueueNotice = now;
            }

            await sleep(600 + Math.floor(Math.random() * 500));
        }
    }

    async function withNamedLock(
        lockName,
        fallbackLockKey,
        task,
        waitingMessage
    ) {
        if (
            navigator.locks &&
            typeof navigator.locks.request === "function"
        ) {
            return navigator.locks.request(
                lockName,
                {mode: "exclusive"},
                task
            );
        }

        return withFallbackLeaseLock(
            fallbackLockKey,
            task,
            waitingMessage
        );
    }

    async function withGlobalTransferLock(task) {
        return withNamedLock(
            GLOBAL_LOCK_NAME,
            FALLBACK_LOCK_KEY,
            task,
            "Waiting for the next Baidu write slot…"
        );
    }

    async function withJobLock(jobIdentity, task) {
        const suffix = jobIdentity.key.slice(JOB_KEY_PREFIX.length);
        return withNamedLock(
            `baidupan-autosave-job-v1:${suffix}`,
            `${FALLBACK_LOCK_KEY}:job:${suffix}`,
            task,
            "Waiting for an identical save job to finish…"
        );
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
            releaseNavigationSlot();
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
            updateQueueEntry({
                state: "done",
                detail: `Already saved to ${destinationPath}`
            });
            showStatus(
                `Already saved to ${destinationPath}; closing this tab…`
            );
            return;
        }

        showStatus(
            `Saving ${fsids.length} item(s) to ${destinationPath}…`
        );
        updateQueueEntry({
            state: "working",
            detail: "Reading account details"
        });
        const bdstoken = await getBdstoken(context.bdstoken);
        updateQueueEntry({
            state: "working",
            detail: `Checking destination ${destinationPath}`
        });
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
        updateQueueEntry({
            state: "done",
            detail: `Saved to ${destinationPath}`,
            completedAt: Date.now()
        });
        showStatus(`Saved to ${destinationPath}; closing this tab…`);
    }

    async function autoSaveCurrentShare() {
        const destinationPath = await getDestinationPath();
        const context = await waitForShareContext();

        if (!context) {
            releaseNavigationSlot();
            showStatus(
                "Auto-save could not read this share. Open the console for details.",
                true
            );
            return;
        }

        const fsids = context.files
            .map((file) => file && file.fs_id)
            .filter(Boolean);

        if (!fsids.length) {
            releaseNavigationSlot();
            return;
        }

        const jobIdentity = buildJobIdentity(
            context,
            fsids,
            destinationPath
        );

        try {
            updateQueueEntry({
                jobKey: jobIdentity.key,
                shareId: String(context.shareId),
                itemCount: fsids.length,
                destinationPath,
                state: "queued",
                detail: "Waiting to start",
                pageTitle: document.title || "Baidu Pan share"
            });
            showStatus(
                `Queued to save ${fsids.length} item(s) to ` +
                `${destinationPath}…`
            );
            await withJobLock(
                jobIdentity,
                () => processTransferJob(
                    context,
                    fsids,
                    destinationPath,
                    jobIdentity
                )
            );
            closeTabAfterSuccess();
        } catch (error) {
            releaseNavigationSlot();
            console.error(
                "[Baidu Pan Auto-Save] Automatic transfer failed:",
                error
            );
            updateQueueEntry({
                state: "failed",
                detail: String(error.message || error),
                failedAt: Date.now(),
                lastError: String(error.message || error)
            });
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
            isExtractionCodeError,
            getRetryDelayMilliseconds,
            buildJobIdentity,
            withGlobalTransferLock,
            performGlobalWrite,
            fetchWithTimeout,
            updateQueueEntry,
            listQueueEntries,
            ensureSettingsButton,
            mountSettingsButton,
            configureDestinationPath,
            registerNavigationRequest,
            tryClaimNavigationSlot,
            renewNavigationSlot,
            releaseNavigationSlot,
            listNavigationRequests,
            cleanupNavigationState
        });
        return;
    }

    if (
        pageWindow.top === pageWindow.self &&
        isPotentialSharePage() &&
        !resumeOwnedNavigationSlot()
    ) {
        window.stop();
        void queueNavigationPageLoad();
        return;
    }

    registerSettingsMenu();
    mountSettingsButton();

    if (
        pageWindow.top === pageWindow.self &&
        isPotentialSharePage()
    ) {
        window.addEventListener(
            "beforeunload",
            removeCurrentQueueEntry,
            {once: true}
        );
        void autoSaveCurrentShare();
    }
})();
