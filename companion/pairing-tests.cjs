const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');

function launch({ menu, initialToken = '', reply = null, hasSource = false, hostname = 'wckbot17.com', images = [], sharedStorage, bodyReady = true } = {}) {
  class Element {
    constructor(tag) { this.tag = tag; this.tagName = tag.toUpperCase(); this.isConnected = false; this.style = {}; this.children = []; this.listeners = {}; this.attributes = {}; this.textContent = ''; this.hidden = false; }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    appendChild(n) { this.children.push(n); n.parentElement = this; n.isConnected = true; return n; }
    attachShadow() { this.testShadow = new Element('shadow'); return this.testShadow; }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] ?? null; }
    getClientRects() { return [{}]; }
    querySelectorAll() { return []; }
    remove() {}
    addEventListener(k, fn) { this.listeners[k] = fn; }
    contains(n) { return n === this || this.children.some(c => c.contains(n)); }
    click() { this.listeners.click?.({stopPropagation(){}}); }
  }
  const body = new Element('body');
  const heading = new Element('h1'); heading.innerText = '示例资源 bf35233';
  const card = new Element('div'); card.innerText = '隐藏内容 链接：https://pan.baidu.com/s/1KeyA 提取码test';
  const label = new Element('span'); label.innerText = '隐藏内容'; card.appendChild(label);
  card.querySelectorAll = selector => selector === '.badge' ? [label] : [];
  const page = {hasSource,images,links:[]};
  const root = bodyReady ? body : new Element('html');
  const windowEvents = {}, documentEvents = {};
  const intervals = [];
  let mutation;
  const timers = [];
  const storage = sharedStorage || new Map([['token', initialToken]]);
  const prompts = [], requests = [], alerts = [];
  const context = {
    window: {getComputedStyle: el => ({display:'block',visibility:'visible',opacity:'1',...el.style}), addEventListener:(name,fn)=>windowEvents[name]=fn, dispatchEvent:event=>windowEvents[event.type]?.(event)},
    CustomEvent: class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    document: {body:bodyReady?body:null, documentElement:root, addEventListener:(name,fn)=>documentEvents[name]=fn, createElement: tag => new Element(tag), querySelector: () => page.hasSource ? heading : null, querySelectorAll: selector => selector==='img'?page.images:(selector==='a[href]'?page.links:(page.hasSource && selector === '.card-body' ? [card] : []))},
    location: {hostname, origin:'https://'+hostname, pathname:hostname==='pan.baidu.com'?'/s/1KeyA':'/zhibo/1.html', href:hostname==='pan.baidu.com'?'https://pan.baidu.com/s/1KeyA':'https://wckbot17.com/zhibo/1.html'},
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => storage.set(key, structuredClone(value)),
    GM_listValues:()=>[...storage.keys()], GM_deleteValue:key=>storage.delete(key),
    GM_xmlhttpRequest: req => requests.push(req),
    prompt: message => { prompts.push(message); return reply; }, alert: msg => alerts.push(msg),
    MutationObserver: class { constructor(fn){mutation = fn;} observe(){} }, setInterval(fn,ms){intervals.push({fn,ms});}, setTimeout(fn){timers.push(fn); return timers.length;}, clearTimeout(){},
    Blob, AbortController,
    TextEncoder, Uint8Array, URL, atob, crypto: webcrypto
  };
  if (menu !== undefined) context.GM_registerMenuCommand = menu;
  vm.runInNewContext(fs.readFileSync(__dirname + '/resource-trace.user.js', 'utf8'), context);
  const shadow = root.children[0].testShadow;
  const panel = shadow.children[1], badge = shadow.children[2];
  const floating = new Element('div'); floating.style = {position:'fixed',top:'10px',left:'10px'};
  const link = new Element('a'); link.href = 'https://pan.baidu.com/s/1KeyA?pwd=demo'; floating.appendChild(link); page.links.push(link);
  const clickSource = (options = {}) => documentEvents[options.type || 'click']({type:'click',button:0,isTrusted:true,target:{closest:()=>link},...options});
  return {clickSource, link, floating, context, storage, prompts, requests, alerts, panel, badge, page, timers, intervals, windowEvents, documentEvents, mutation: (...args) => mutation(...args), diagnostics: panel.children[6]};
}

test('AdGuard without a toolbar menu can click the badge and save the app token', () => {
  const token = 'local-test-token-'.repeat(4);
  const app = launch({reply: token});
  assert.match(app.badge.textContent, /Click here to pair/);
  app.badge.click();
  assert.equal(app.prompts.length, 1);
  assert.equal(app.storage.get('token'), token);
  assert.match(app.prompts[0], /Copy browser pairing token/);
});
test('a missing, throwing or present menu API preserves all inline controls', () => {
  for (const menu of [undefined, () => {throw new Error('unsupported');}, () => {}]) {
    const app = launch({menu, initialToken:'existing-test-token-'.repeat(4)});
    app.badge.click();
    assert.equal(app.panel.hidden, false);
    assert.deepEqual(app.panel.children.slice(0,6).map(b => b.textContent), ['Pair / change token','Capture this page again','Enter archive filename','Retry rejected captures','Test connection','Export queued captures']);
    app.panel.children[0].click();
    assert.equal(app.prompts.length, 1);
    assert.equal(app.panel.hidden, true);
  }
});
test('invalid or cancelled pairing never replaces the existing token', () => {
  const token = 'existing-test-token-'.repeat(4);
  for (const reply of [null, '', 'short']) {
    const app = launch({initialToken: token, reply});
    app.panel.children[0].click();
    assert.equal(app.storage.get('token'), token);
  }
});
test('inline manual filename uses privileged authenticated HTTP after pairing', async () => {
  const token = 'existing-test-token-'.repeat(4);
  const app = launch({initialToken: token, reply:'random.7z'});
  app.context.location.href = 'https://pan.baidu.com/s/1KeyA';
  app.context.location.hostname = 'pan.baidu.com';
  app.panel.children[2].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers.Authorization, 'Bearer ' + token);
  assert.equal(JSON.parse(app.requests[0].data).filename, 'random.7z');
  assert.equal(app.requests[0].url, 'http://127.0.0.1:49731/capture');
});

test('page load, observer, timers and lifecycle events never ingest a purchase before the floating link click', () => {
  const app = launch({initialToken:'test-token-'.repeat(5),hasSource:true});
  app.mutation([{target:{}}]); app.timers.at(-1)();
  for (const interval of app.intervals) interval.fn();
  for (const name of ['pageshow','pagehide']) app.windowEvents[name]();
  app.documentEvents.DOMContentLoaded();
  app.panel.children[1].click();
  assert.equal(app.requests.length,0);
  assert.match(app.diagnostics.textContent,/Click the floating Baidu link/);
  app.clickSource();
  assert.equal(app.requests.length,1);
  const data = JSON.parse(app.requests[0].data);
  assert.equal(data.kind,'source'); assert.equal(data.title,'示例资源 bf35233');
  assert.equal(data.directURL,app.link.href);
});
test('only a real click on the top-left floating purchased share is accepted', () => {
  const app = launch({initialToken:'test-token-'.repeat(5),hasSource:true});
  app.clickSource({isTrusted:false});
  app.clickSource({button:2});
  app.floating.style.position='static'; app.clickSource();
  app.floating.style.position='fixed'; app.link.href='https://pan.baidu.com/s/1Other?pwd=demo'; app.clickSource();
  assert.equal(app.requests.length,0);
  app.link.href='https://pan.baidu.com/s/1KeyA?pwd=demo';
  app.clickSource({type:'auxclick',button:1});
  assert.equal(app.requests.length,1);
});
test('an unpaid page is not ingested even on a floating link click', () => {
  const app = launch({initialToken:'test-token-'.repeat(5)}); app.clickSource();
  assert.equal(app.requests.length,0);
});
test('network failures are reported as connection failures and preserve captures', async () => {
  const app = launch({initialToken:'test-token-'.repeat(5), hasSource:true});
  app.clickSource();
  await new Promise(resolve => setImmediate(resolve));
  app.requests[0].onerror({error:'network unavailable'});
  await new Promise(resolve => setImmediate(resolve));
  assert.match(app.badge.textContent,/connection failed/);
  assert.doesNotMatch(app.badge.textContent,/start app/);
  assert.equal([...app.storage.keys()].filter(key=>key.startsWith('rt.pending.')).length,1);
});
test('explicit connection test enables browser fallback only after GM fails', async () => {
  const app = launch({initialToken:'test-token-'.repeat(5)});
  const fetches = [];
  app.context.fetch = async (url, options) => { fetches.push({url,options}); return {status:200, text:async()=>JSON.stringify({message:'ResourceTrace connection OK; protocol 2'})}; };
  app.panel.children[4].click();
  assert.equal(fetches.length,0);
  app.requests[0].onerror({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches[0].options.targetAddressSpace,'loopback');
  assert.equal(app.storage.get('transport'),'fetch');
});
test('queued capture export contains metadata and never the pairing token', async () => {
  const token = 'secret-token-'.repeat(5);
  const app = launch({initialToken:token,hasSource:true});
  app.clickSource();
  await new Promise(resolve => setImmediate(resolve));
  let blob;
  const oldCreate = URL.createObjectURL;
  URL.createObjectURL = value => {blob = value;return 'blob:test';};
  try { app.panel.children[5].click(); } finally { URL.createObjectURL = oldCreate; }
  const text = await blob.text();
  const data = JSON.parse(text);
  assert.equal(data.captures.length,1); assert.equal(data.schemaVersion,1);
  assert.ok(!text.includes(token)); assert.equal([...app.storage.keys()].filter(key=>key.startsWith('rt.pending.')).length,1);
});

function filenameImage() {
  const src='data:image/png;base64,'+fs.readFileSync(__dirname+'/fixtures/baidu-filename.png').toString('base64');
  return {src,naturalWidth:0,naturalHeight:0,parentElement:null,hidden:false,getAttribute:()=>null,getClientRects:()=>[{}]};
}
test('Baidu filename image queues synchronously before decode or any async turn', () => {
  const image=filenameImage();
  const app=launch({initialToken:'test-token-'.repeat(5),hostname:'pan.baidu.com',images:[image]});
  const keys=[...app.storage.keys()].filter(key=>key.startsWith('rt.pending.'));
  assert.equal(keys.length,1);
  assert.equal(app.storage.get(keys[0]).capture.imageDataURL,image.src);
  assert.equal(app.requests.length,1);
});
test('document-start with no body and a late image captures in the mutation callback', () => {
  const app=launch({initialToken:'test-token-'.repeat(5),hostname:'pan.baidu.com',bodyReady:false});
  app.page.images=[filenameImage()]; app.mutation([{target:{}}]);
  assert.equal(app.requests.length,1);
  assert.equal([...app.storage.keys()].filter(key=>key.startsWith('rt.pending.')).length,1);
});
test('another open source tab drains the queued evidence after the Baidu tab closes', async () => {
  const shared=new Map([['token','test-token-'.repeat(5)]]);
  const source=launch({sharedStorage:shared}); // start before the evidence exists
  const baidu=launch({sharedStorage:shared,hostname:'pan.baidu.com',images:[filenameImage()]});
  // Discard the Baidu context before any request completes; only shared storage remains.
  assert.equal(baidu.requests.length,1);
  source.intervals.find(item=>item.ms===2000).fn();
  assert.equal(source.requests.length,1);
  assert.equal(JSON.parse(source.requests[0].data).kind,'baidu');
  source.requests[0].onload({status:200,responseText:'{}'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal([...shared.keys()].filter(key=>key.startsWith('rt.pending.')).length,0);
});
test('independent tab captures do not overwrite each other with stale queues', async () => {
  const shared=new Map([['token','test-token-'.repeat(5)]]);
  const a=launch({sharedStorage:shared,reply:'one.7z'}), b=launch({sharedStorage:shared,reply:'two.zip'});
  for (const app of [a,b]) { app.context.location.href='https://pan.baidu.com/s/1KeyA'; app.context.location.hostname='pan.baidu.com'; app.panel.children[2].click(); }
  assert.equal([...shared.keys()].filter(key=>key.startsWith('rt.pending.')).length,2);
  a.requests[0].onload({status:200,responseText:'{}'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal([...shared.keys()].filter(key=>key.startsWith('rt.pending.')).length,1);
});
test('legacy queued evidence migrates without losing rejected captures', () => {
  const shared=new Map([['token','test-token-'.repeat(5)],['captureQueue',[{id:'legacy',capture:{kind:'baidu',baiduURL:'https://pan.baidu.com/s/1KeyA',filename:'old.7z'}}]],['rejectedCaptures',[{id:'refused',capture:{kind:'baidu',baiduURL:'https://pan.baidu.com/s/1KeyA',filename:'refused.7z'}}]]]);
  const app=launch({sharedStorage:shared});
  assert.equal(app.requests.length,1); assert.ok(shared.has('rt.pending.legacy')); assert.ok(shared.has('rt.rejected.refused'));
});


test('close-time acknowledgement is emitted only after visible evidence is queued', () => {
  const app = launch({hostname:'pan.baidu.com', initialToken:'existing-test-token-'.repeat(4)});
  let acknowledgement;
  app.windowEvents['resourcetrace:capture-status'] = event => {
    acknowledgement = JSON.parse(event.detail);
    if (acknowledgement.status === 'ready') assert.equal([...app.storage.keys()].filter(key=>key.startsWith('rt.pending.')).length, 1);
  };
  const request = () => app.windowEvents['resourcetrace:capture-request']({detail:'test-close-123'});
  request();
  assert.equal(acknowledgement.status, 'waiting');
  const header = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(header);
  header.write('IHDR',12); header.writeUInt32BE(283,16); header.writeUInt32BE(30,20);
  app.page.images.push({src:'data:image/png;base64,'+header.toString('base64'),getClientRects:()=>[{}],getAttribute:()=>null,parentElement:null});
  request();
  assert.deepEqual(acknowledgement,{requestID:'test-close-123',status:'ready'});
  assert.equal(app.requests.length,1);
  assert.deepEqual(Object.keys(acknowledgement).sort(),['requestID','status']);
});
test('close-time handshake reports inactive for unpaired scripts and ignores invalid requests', () => {
  const app = launch({hostname:'pan.baidu.com'});
  const acknowledgements = [];
  app.windowEvents['resourcetrace:capture-status'] = event=>acknowledgements.push(JSON.parse(event.detail));
  app.windowEvents['resourcetrace:capture-request']({detail:'test-close-123'});
  assert.equal(acknowledgements[0].status,'inactive');
  app.windowEvents['resourcetrace:capture-request']({detail:{requestID:'bad'}});
  app.windowEvents['resourcetrace:capture-request']({detail:'bad/request'});
  assert.equal(acknowledgements.length,1);
});


test('click intent survives a purchased card appearing later', () => {
  const app = launch({initialToken:'test-token-'.repeat(5)});
  app.clickSource(); assert.equal(app.requests.length,0);
  app.page.hasSource=true;
  app.mutation([{target:{}}]); app.timers.at(-1)();
  assert.equal(app.requests.length,1);
  assert.equal(JSON.parse(app.requests[0].data).directURL,app.link.href);
});
