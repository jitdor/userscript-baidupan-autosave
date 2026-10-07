// ==UserScript==
// @name         ResourceTrace — purchased resource provenance
// @namespace    local.resourcetrace
// @version      1.0.11
// @homepageURL  https://github.com/jitdor/userscript-baidupan-autosave
// @updateURL    https://raw.githubusercontent.com/jitdor/userscript-baidupan-autosave/main/companion/resource-trace.user.js
// @downloadURL  https://raw.githubusercontent.com/jitdor/userscript-baidupan-autosave/main/companion/resource-trace.user.js
// @description  Confirm clicked purchases in the Mac app before opening their Baidu link; capture filename evidence. No passcode entry or downloads.
// @match        https://wckbot17.com/*
// @match        https://pan.baidu.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';
  function shareKey(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.hostname !== 'pan.baidu.com') return null;
      const m = u.pathname.match(/^\/s\/1([A-Za-z0-9_-]+)\/?$/);
      if (m) return m[1];
      const id = u.searchParams.get('surl');
      return u.pathname === '/share/init' && /^[A-Za-z0-9_-]+$/.test(id || '') ? id : null;
    } catch { return null; }
  }
  function archiveName(raw) {
    const n = (raw || '').trim().normalize('NFC');
    return n && !/[\/\\\x00-\x1f\x7f]/.test(n) && /\.(7z|zip)$/i.test(n) && new TextEncoder().encode(n).length <= 255 ? n : null;
  }
  function titleArchiveName(raw) {
    const title = (raw || '').trim();
    // Preserve spaces, Unicode and punctuation in the filename. Only strip
    // known service suffixes; generic/loading/multiple-file titles fall back.
    const match = title.match(/^(.+\.(?:7z|zip))(?:\s*[-_|–—]\s*(?:百度网盘|百度云|免费高速下载|Baidu Netdisk).*|\s*)$/i);
    return match && (match[1].match(/\.(?:7z|zip)(?=\s|$)/gi) || []).length === 1 ? archiveName(match[1]) : null;
  }
  function visible(el, style = window.getComputedStyle.bind(window)) {
    if (!el || !el.getClientRects().length) return false;
    for (let p = el; p; p = p.parentElement) {
      const s = style(p);
      if (p.hidden || p.getAttribute('aria-hidden') === 'true' || s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
    }
    return true;
  }
  function passcodeLink(raw, expectedKey) {
    try {
      const u = new URL(raw), pwd = u.searchParams.get('pwd');
      return raw.length <= 8192 && u.protocol === 'https:' && u.hostname === 'pan.baidu.com' && !u.username && !u.password && (!u.port || u.port === '443') && /^\/s\/1[A-Za-z0-9_-]+\/?$/.test(u.pathname) && shareKey(raw) === expectedKey && pwd && pwd.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(pwd) ? raw : null;
    } catch { return null; }
  }
  function parsePurchased(title, sourceURL, text, hrefs, injectedHrefs = []) {
    if (!title || !text.includes('隐藏内容')) return [];
    const urls = new Set([...(text.match(/https:\/\/pan\.baidu\.com\/s\/1[A-Za-z0-9_-]+(?:\?[^\s<>，。]*)?/g) || []), ...hrefs]);
    return [...urls].filter(shareKey).map(baiduURL => {
      const capture = { kind: 'source', title: title.trim(), sourceURL, baiduURL, notes: text.slice(0, 30000), purchasedVisible: true };
      const key = shareKey(baiduURL);
      const candidates = [...new Set([...injectedHrefs, ...hrefs, baiduURL].map(raw => passcodeLink(raw, key)).filter(Boolean))];
      if (candidates.length === 1) capture.directURL = candidates[0];
      return capture;
    });
  }
  // Synchronous SHA-256 is used only for queue identity, so capturing a short-lived
  // tab never awaits WebCrypto before writing the evidence to manager storage.
  function captureID(capture) {
    const bytes = new TextEncoder().encode(JSON.stringify(capture));
    const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64); data.set(bytes); data[bytes.length] = 128;
    const view = new DataView(data.buffer), bits = bytes.length * 8;
    view.setUint32(data.length - 8, Math.floor(bits / 4294967296)); view.setUint32(data.length - 4, bits >>> 0);
    const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Uint32Array(64);
    const rot = (x,n) => (x >>> n) | (x << (32-n));
    for (let offset = 0; offset < data.length; offset += 64) {
      for (let i=0;i<16;i++) w[i] = view.getUint32(offset + i*4);
      for (let i=16;i<64;i++) {
        const x=w[i-15], y=w[i-2];
        w[i] = (w[i-16] + (rot(x,7)^rot(x,18)^(x>>>3)) + w[i-7] + (rot(y,17)^rot(y,19)^(y>>>10))) >>> 0;
      }
      let [a,b,c,d,e,f,g,q] = h;
      for (let i=0;i<64;i++) {
        const t1=(q + (rot(e,6)^rot(e,11)^rot(e,25)) + ((e&f)^(~e&g)) + k[i] + w[i]) >>> 0;
        const t2=((rot(a,2)^rot(a,13)^rot(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
        q=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      [a,b,c,d,e,f,g,q].forEach((n,i)=>h[i]=(h[i]+n)>>>0);
    }
    return h.map(n=>n.toString(16).padStart(8,'0')).join('');
  }
  function pngDimensions(src) {
    try {
      if (!src.startsWith('data:image/png;base64,')) return null;
      const header = atob(src.slice(22,54));
      if (header.length < 24 || header.slice(0,8) !== '\x89PNG\r\n\x1a\n' || header.slice(12,16) !== 'IHDR') return null;
      const number = start => [0,1,2,3].reduce((n,i)=>n*256+header.charCodeAt(start+i),0);
      return {width:number(16),height:number(20)};
    } catch { return null; }
  }
  // Pure helpers are exported only to the offline test harness.
  if (typeof module !== 'undefined' && module.exports) { module.exports = { shareKey, archiveName, titleArchiveName, visible, parsePurchased, passcodeLink, captureID, pngDimensions }; return; }

  const endpoint = 'http://127.0.0.1:49731/capture';
  let token = GM_getValue('token', '');
  const pendingPrefix = 'rt.pending.', sentPrefix = 'rt.sent.', rejectedPrefix = 'rt.rejected.';
  const storageKeys = prefix => GM_listValues().filter(key => key.startsWith(prefix));
  function readPending() {
    return storageKeys(pendingPrefix).map(key => GM_getValue(key, null)).filter(item => item?.id && item.capture).sort((a,b)=>(a.at||0)-(b.at||0));
  }
  function readRejected() { return storageKeys(rejectedPrefix).map(key => GM_getValue(key,null)).filter(item=>item?.id && item.capture); }
  // Import the previous array queue once; per-evidence keys prevent one tab's
  // stale snapshot from overwriting captures produced by a different tab.
  for (const id of GM_getValue('delivered',[])) GM_setValue(sentPrefix+id,true);
  for (const item of GM_getValue('captureQueue',[])) if (!GM_getValue(sentPrefix+item.id,false)) GM_setValue(pendingPrefix+item.id,item);
  for (const item of GM_getValue('rejectedCaptures',[])) GM_setValue(rejectedPrefix+item.id,item);
  for (const key of ['captureQueue','delivered','rejectedCaptures']) GM_deleteValue(key);
  let queue = readPending();
  let sending = false;
  let retryAt = 0;
  let failures = 0;
  let warning = '';
  let transport = GM_getValue('transport', 'gm');
  let autoStatus = 'Waiting for page content';
  let connectionStatus = 'Not tested';
  // Keep controls on the page: AdGuard for Mac has no userscript-toolbar menu.
  // Native prompt keeps the pairing token out of page inputs and DOM attributes.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed!important;bottom:12px!important;right:12px!important;z-index:2147483647!important;display:block!important';
  const controls = host.attachShadow({ mode: 'closed' });
  const css = document.createElement('style');
  css.textContent = `
    :host { color-scheme: light; }
    button { font:13px system-ui; cursor:pointer; }
    .badge { padding:10px 14px; background:#183d3a; color:#fff; border:0; border-radius:8px;
      max-width:340px; text-align:left; box-shadow:0 2px 8px #0004; line-height:1.4; }
    .badge:focus-visible, .actions button:focus-visible { outline:3px solid #57beb3; outline-offset:2px; }
    .actions { background:#fff; color:#183d3a; border:1px solid #ddd; border-radius:10px;
      padding:6px; margin-bottom:8px; box-shadow:0 2px 12px #0003; }
    .actions[hidden] { display:none; }
    .actions button { display:block; width:100%; text-align:left; padding:10px; background:transparent;
      color:#183d3a; border:0; border-radius:5px; }
    .actions button:hover { background:#edf6f4; }
  `;
  const panel = document.createElement('div');
  panel.className = 'actions'; panel.hidden = true;
  panel.setAttribute('aria-label', 'ResourceTrace controls');
  const badge = document.createElement('button');
  badge.type = 'button'; badge.className = 'badge';
  badge.setAttribute('aria-expanded', 'false');
  badge.title = 'Click for ResourceTrace pairing and capture controls';
  controls.append(css, panel, badge);
  function mountControls() {
    const parent = document.body || document.documentElement;
    if (parent && !host.isConnected) parent.appendChild(host);
  }
  mountControls();
  function show(message) { badge.textContent = `ResourceTrace: ${message}`; }
  const diagnostics = document.createElement('p');
  diagnostics.style.cssText = 'font:12px system-ui;max-width:320px;white-space:pre-wrap;padding:6px 10px;margin:0;color:#52615f';
  function updateDiagnostics() { diagnostics.textContent = `Auto capture: ${autoStatus}\nConnection: ${connectionStatus}\nQueued: ${queue.length}`; }
  function addControl(label, action) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', event => {
      event.stopPropagation(); panel.hidden = true; badge.setAttribute('aria-expanded', 'false'); action();
    });
    panel.appendChild(button);
  }
  badge.addEventListener('click', event => {
    event.stopPropagation();
    if (!token) { pair(); return; }
    panel.hidden = !panel.hidden; badge.setAttribute('aria-expanded', String(!panel.hidden));
  });
  badge.addEventListener('keydown', event => {
    if (event.key === 'Escape') { panel.hidden = true; badge.setAttribute('aria-expanded', 'false'); }
  });
  function enqueue(capture, send = true) {
    const bytes = new TextEncoder().encode(JSON.stringify(capture));
    if (bytes.length > 1000000) { show('Capture too large; enter filename manually'); return false; }
    const id = captureID(capture);
    if (GM_getValue(sentPrefix+id,false) || GM_getValue(pendingPrefix+id,null)) return true;
    if (GM_getValue(rejectedPrefix+id,null)) return false;
    queue = readPending();
    if (queue.length >= 120) { warning = 'Queue full: start app and retry capture'; show(warning); return false; }
    const item = {id,capture,at:Date.now()};
    // No await before this write. OCR happens locally after evidence is received.
    GM_setValue(pendingPrefix+id,item); queue.push(item); updateDiagnostics(); if (send) flush(id); return true;
  }
  function request(method, path, data, mode = transport) {
    if (mode === 'fetch') {
      if (typeof fetch !== 'function') return Promise.reject(new Error('Browser fetch is unavailable'));
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 45000);
      // Edge's loopback permission remains under the user's control. This mode is
      // enabled only by the on-page Test connection action after GM transport fails.
      return fetch(endpoint.replace('/capture', path), {
        method, mode: 'cors', credentials: 'omit', targetAddressSpace: 'loopback', signal: abort.signal,
        headers: { Authorization: `Bearer ${token}`, ...(data ? {'Content-Type':'application/json'} : {}) },
        ...(data ? {body: data} : {})
      }).then(async r => ({status:r.status, responseText:await r.text()})).finally(() => clearTimeout(timer));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = action => value => { if (settled) return; settled = true; clearTimeout(timer); action(value); };
      const timer = setTimeout(done(reject), 46000, new Error('Userscript request timed out'));
      try {
        if (typeof GM_xmlhttpRequest !== 'function') { done(reject)(new Error('GM_xmlhttpRequest is unavailable')); return; }
        GM_xmlhttpRequest({method, url:endpoint.replace('/capture', path),
          headers:{ Authorization:`Bearer ${token}`, ...(data ? {'Content-Type':'application/json'} : {}) },
          ...(data ? {data} : {}), timeout:45000,
          onload:done(resolve), onerror:done(reject), ontimeout:done(() => reject(new Error('Userscript request timed out')))
        });
      } catch (error) { done(reject)(error); }
    });
  }
  function responseMessage(response) {
    try { const msg = JSON.parse(response.responseText || '').message; return typeof msg === 'string' ? msg.slice(0,180) : ''; } catch { return ''; }
  }
  function networkError(error) {
    const raw = error?.message || error?.error || error?.statusText;
    const detail = typeof raw === 'string' ? raw.replaceAll(token, '[token]').replace(/Bearer\s+\S+/gi, 'Bearer [token]').replace(/[\r\n]/g,' ').slice(0,140) : 'No readable network response';
    return detail;
  }
  function connectionFailed(reason) {
    failures++; retryAt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
    connectionStatus = reason; updateDiagnostics();
    show(`${queue.length} queued — connection failed; click for Test connection`);
  }
  async function flush(preferredID = null) {
    queue = readPending(); token = GM_getValue('token',token); transport = GM_getValue('transport',transport);
    if (sending || !queue.length || !token || Date.now() < retryAt) return;
    sending = true;
    const item = queue.find(item => item.id === preferredID) || queue[0]; connectionStatus = `Sending using ${transport}`; updateDiagnostics();
    try {
      const response = await request('POST', '/capture', JSON.stringify(item.capture));
      if (response.status === 200) {
        GM_setValue(sentPrefix+item.id,true); GM_deleteValue(pendingPrefix+item.id); GM_deleteValue(rejectedPrefix+item.id);
        const sent = storageKeys(sentPrefix); for (const key of sent.slice(0,Math.max(0,sent.length-2000))) GM_deleteValue(key);
        queue = readPending(); failures = 0; retryAt = 0;
        connectionStatus = 'Capture accepted by Mac app'; updateDiagnostics();
        show(queue.length ? `${queue.length} captures waiting` : 'Captured — review filenames in app');
      } else if (response.status === 401) {
        retryAt = Date.now() + 60000; connectionStatus = 'Pairing token rejected'; updateDiagnostics(); show('Token rejected — click here to pair again');
      } else if ([422,400,413].includes(response.status)) {
        GM_setValue(rejectedPrefix+item.id,item); GM_deleteValue(pendingPrefix+item.id);
        const rejected = storageKeys(rejectedPrefix); for (const key of rejected.slice(0,Math.max(0,rejected.length-40))) GM_deleteValue(key);
        queue = readPending();
        connectionStatus = `HTTP ${response.status}: ${responseMessage(response)}`; updateDiagnostics();
        show('Capture refused — click for details or export');
      } else {
        connectionFailed(`HTTP ${response.status || 0}: ${responseMessage(response) || 'No readable response'}`);
      }
    } catch (error) {
      connectionFailed(`${networkError(error)}; use Test connection or export`);
    } finally { sending = false; if (queue.length && Date.now() >= retryAt) flush(); }
  }
  async function testConnection() {
    if (!token) { pair(); return; }
    show('Testing connection to the Mac app…'); connectionStatus = 'Testing'; updateDiagnostics();
    let response;
    try { response = await request('GET', '/health', null, 'gm'); } catch { /* Try browser transport after this user action. */ }
    if (!response || !response.status) {
      try {
        show('Testing browser connection — Edge may ask for local access');
        response = await request('GET', '/health', null, 'fetch');
        if (response.status === 200) { transport = 'fetch'; GM_setValue('transport', transport); }
      } catch {
        connectionStatus = 'GM and browser transport failed. Check Edge site Local network access; exported captures can be imported instead.';
        updateDiagnostics(); show('Connection blocked — click for details or Export queued captures'); return;
      }
    } else if (response.status === 200) { transport = 'gm'; GM_setValue('transport', transport); }
    connectionStatus = `HTTP ${response.status}: ${responseMessage(response)}`; updateDiagnostics();
    if (response.status === 200) { retryAt = 0; failures = 0; show('Connected to Mac app'); capture(); }
    else if (response.status === 401) show('Token rejected — click Pair / change token');
    else if (response.status === 404) show('Older app detected — update ResourceTrace to 1.0.2');
    else show(`Connection test returned HTTP ${response.status} — click for details`);
  }
  function exportQueued() {
    queue = readPending(); const rejected = readRejected();
    const unique = new Map([...queue,...rejected].map(item => [item.id,item]));
    const captures = [...unique.values()].slice(0,120).map(item => item.capture);
    if (!captures.length) { show('No queued captures to export'); return; }
    const blob = new Blob([JSON.stringify({schemaVersion:1,captures},null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'resource-trace-captures.json';
    controls.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    show('Exported — use Import browser captures in the Mac app');
    // Keep queued evidence until the app accepts it; export alone is not delivery.
  }
  // Source intent is per page, never inferred from loading or observing it.
  let selectedSourceURL = null;
  function captureSource(collect = null) {
    if (!selectedSourceURL) { autoStatus = 'Click the floating Baidu link at the top left to track this purchase'; updateDiagnostics(); return 0; }
    const heading = document.querySelector('h1.entry-title');
    if (!visible(heading)) { autoStatus = 'No visible h1.entry-title yet'; updateDiagnostics(); return 0; }
    let count = 0;
    const injectedHrefs = [...document.querySelectorAll('a[href]')].filter(a => visible(a)).map(a => a.href);
    for (const card of document.querySelectorAll('.card-body')) {
      if (!visible(card)) continue;
      const label = [...card.querySelectorAll('.badge')].some(b => visible(b) && b.innerText.includes('隐藏内容'));
      if (!label) continue;
      const text = card.innerText;
      const hrefs = [...card.querySelectorAll('a[href]')].filter(a => visible(a)).map(a => a.href);
      for (const capture of parsePurchased(heading.innerText, location.origin + location.pathname, text, hrefs, injectedHrefs)) {
        if (shareKey(capture.baiduURL) !== shareKey(selectedSourceURL)) continue;
        const direct = passcodeLink(selectedSourceURL, shareKey(capture.baiduURL));
        if (direct) capture.directURL = direct;
        try { if (collect) { collect.push(capture); count++; } else if (enqueue(capture)) count++; } catch { autoStatus = 'Could not prepare capture'; updateDiagnostics(); } }
    }
    autoStatus = count ? `${count} visible purchased share(s) found on this page` : 'No visible purchased card with a Baidu share found';
    updateDiagnostics(); return count;
  }
  function captureBaidu() {
    if (!shareKey(location.href)) { autoStatus = 'No supported share URL on this Baidu page'; updateDiagnostics(); return; }
    autoStatus = 'Observing visible Baidu filename evidence'; updateDiagnostics();
    const baiduURL = location.href;
    const titleName = titleArchiveName(document.title);
    if (titleName) {
      autoStatus = 'Archive filename read from page title'; updateDiagnostics();
      return enqueue({kind:'baidu', baiduURL, filename:titleName, filenameSource:'page-title'}) ? 1 : 0;
    }
    const found = new Set(); let queued = 0;
    // Prefer accessible text, but all captured names still require user review.
    const elements = document.querySelectorAll('[title], [aria-label], .filename, .file-name, .file-name-text, .file-name-item');
    for (const el of [...elements].slice(0, 600)) {
      if (!visible(el)) continue;
      for (const value of [el.getAttribute('title'), el.getAttribute('aria-label'), el.innerText]) {
        const name = archiveName(value);
        if (name && !found.has(name)) { found.add(name); if (enqueue({ kind: 'baidu', baiduURL, filename: name })) queued++; }
      }
    }
    let images = 0;
    for (const img of document.querySelectorAll('img')) {
      if (!visible(img) || !img.src.startsWith('data:image/png;base64,') || img.src.length > 1000000) continue;
      // Read IHDR dimensions immediately; waiting for the browser to decode
      // naturalWidth can miss a tab closed just after its save operation.
      const size = pngDimensions(img.src);
      if (!size || size.width < 80 || size.width > 4096 || size.height > 200 || size.height < 8 || size.width < size.height*2) continue;
      if (enqueue({ kind: 'baidu', baiduURL, imageDataURL: img.src })) queued++;
      if (++images >= 12) break;
    }
    return queued;
  }
  function capture() {
    mountControls(); token = GM_getValue('token',token);
    if (!token) { show('Click here to pair with the Mac app'); return; }
    if (/^wckbot\d*\.com$/.test(location.hostname)) {
      const count = captureSource();
      if (!queue.length && !sending && connectionStatus === 'Not tested') show(count ? 'Selected purchase captured' : 'Click the top-left Baidu link to track this purchase');
    } else if (location.hostname === 'pan.baidu.com') captureBaidu();
    flush();
  }
  function pair() {
    const value = prompt('In the ResourceTrace Mac app, click “Copy browser pairing token”. Paste the copied token here:');
    if (value === null) return;
    if (!value || value.trim().length < 32) { show('Invalid token — copy it from the Mac app, then click here'); return; }
    token = value.trim(); GM_setValue('token', token); retryAt = 0; warning = ''; failures = 0;
    show('Token saved'); capture();
  }
  function recapture() { for (const key of storageKeys(sentPrefix)) GM_deleteValue(key); retryAt = 0; warning = ''; capture(); }
  function enterFilename() {
    if (!shareKey(location.href)) { alert('Use this control on a Baidu share page.'); return; }
    const name = archiveName(prompt('Exact displayed archive filename (.7z or .zip):'));
    if (name) enqueue({ kind: 'baidu', baiduURL: location.href, filename: name });
  }
  function retryRejected() {
    queue = readPending();
    for (const item of readRejected()) {
      if (queue.length >= 120) break;
      if (!GM_getValue(pendingPrefix+item.id,null)) { GM_setValue(pendingPrefix+item.id,item); queue.push(item); }
      GM_deleteValue(rejectedPrefix+item.id);
    }
    retryAt = 0; warning = ''; flush();
  }
  const actions = [
    ['Pair / change token', pair],
    ['Capture this page again', recapture],
    ['Enter archive filename', enterFilename],
    ['Retry rejected captures', retryRejected],
    ['Test connection', testConnection],
    ['Export queued captures', exportQueued]
  ];
  for (const [label, action] of actions) {
    addControl(label, action);
    // Toolbar menus remain a convenience for managers that expose them.
    // Missing or unsupported menu APIs must never prevent on-page controls.
    if (typeof GM_registerMenuCommand === 'function') {
      try { GM_registerMenuCommand(`ResourceTrace: ${label}`, action); } catch { /* On-page control remains available. */ }
    }
  }
  panel.appendChild(diagnostics);
  updateDiagnostics();
  // Optional close-time coordination with Baidu Pan Auto-Save. Only status and
  // an opaque request ID cross the DOM; no title, image, URL or token is exposed.
  window.addEventListener('resourcetrace:capture-request', event => {
    if (location.hostname !== 'pan.baidu.com' || typeof event.detail !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(event.detail)) return;
    token = GM_getValue('token',token);
    let status = 'inactive';
    if (token && shareKey(location.href)) {
      try { status = captureBaidu() > 0 ? 'ready' : 'waiting'; } catch { status = 'waiting'; }
    }
    window.dispatchEvent(new CustomEvent('resourcetrace:capture-status', {detail:JSON.stringify({requestID:event.detail,status})}));
  });
  let navigationPending = false;
  async function sourceLinkClick(event) {
    if (!/^wckbot\d*\.com$/.test(location.hostname) || !event.isTrusted || (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0)) return;
    const link = event.target?.closest?.('a[href]');
    if (!link || !visible(link) || !shareKey(link.href)) return;
    let floating = false;
    for (let parent = link.parentElement; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      const top = parseFloat(style.top), left = parseFloat(style.left);
      if (style.position === 'fixed' && top >= 0 && top <= 80 && left >= 0 && left <= 80) { floating = true; break; }
    }
    if (!floating) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (navigationPending) { show('Waiting for app acknowledgement'); return; }
    selectedSourceURL = link.href;
    const captures = []; captureSource(captures);
    if (!captures.length) { show('Not opened — matching visible purchased card required'); return; }
    token = GM_getValue('token',token);
    if (!token) { for (const capture of captures) enqueue(capture,false); show('Not opened — pair with the Mac app, then click the link again'); return; }
    navigationPending = true;
    const href = link.href;
    const newTab = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey || (link.target && link.target !== '_self');
    // Reserve a blank tab during the user gesture, so browser popup protection
    // does not block it later. No Baidu request happens until acknowledgement.
    let destination = null;
    if (newTab) { destination = window.open('about:blank','_blank'); if (destination) destination.opener = null; }
    let opened = false;
    try {
      show('Waiting for Mac app — Baidu has not opened');
      for (const capture of new Map(captures.map(c => [captureID(c),c])).values()) {
        const id = captureID(capture);
        // An old sent marker is not proof the current running app has this job.
        GM_deleteValue(sentPrefix+id);
        if (!enqueue(capture,false)) throw new Error('Capture could not be queued');
        const response = await request('POST','/capture',JSON.stringify(capture));
        const message = responseMessage(response);
        if (response.status !== 200 || message !== 'Source captured') throw new Error(message || `App did not confirm purchase (HTTP ${response.status})`);
        GM_setValue(sentPrefix+id,true); GM_deleteValue(pendingPrefix+id); GM_deleteValue(rejectedPrefix+id);
      }
      queue = readPending(); connectionStatus = 'Purchase acknowledged by Mac app'; updateDiagnostics();
      if (newTab) {
        if (!destination || destination.closed) { show('App confirmed — allow popups and click the link again to open Baidu'); return; }
        destination.location.replace(href);
      } else window.location.assign(href);
      opened = true; show('App confirmed — opening Baidu');
    } catch (error) {
      show(`Not opened — ${networkError(error)}. Start/pair the app, then click the link again`);
    } finally {
      if (!opened && destination && !destination.closed) destination.close();
      navigationPending = false;
    }
  }
  // Stop the original link action before document/overlay handlers navigate.
  window.addEventListener('click', sourceLinkClick, true);
  window.addEventListener('auxclick', sourceLinkClick, true);
  let debounce;
  const observer = new MutationObserver(mutations => {
    if (mutations.every(m => m.target === host || host.contains(m.target))) return;
    if (location.hostname === 'pan.baidu.com') { capture(); return; }
    clearTimeout(debounce); debounce = setTimeout(capture, 1200);
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  document.addEventListener('load', event => { if (event.target?.tagName === 'IMG') capture(); }, true);
  window.addEventListener('pagehide', capture);
  window.addEventListener('pageshow', capture);
  document.addEventListener('DOMContentLoaded', capture);
  setInterval(() => { flush(); updateDiagnostics(); }, 2000);
  setInterval(() => { capture(); if (warning) show(warning); }, 15000);
  capture();
})();
