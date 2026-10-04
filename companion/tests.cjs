const test = require('node:test');
const assert = require('node:assert/strict');
const { shareKey, archiveName, visible, parsePurchased, captureID, pngDimensions } = require('./resource-trace.user.js');
test('share identity survives passcode parameters and share/init redirect', () => {
  assert.equal(shareKey('https://pan.baidu.com/s/1Ab_C-9?pwd=1234#foo'), 'Ab_C-9');
  assert.equal(shareKey('https://pan.baidu.com/share/init?surl=Ab_C-9'), 'Ab_C-9');
  assert.equal(shareKey('https://pan.baidu.com/share/init?surl=1Ab_C-9'), '1Ab_C-9');
  assert.equal(shareKey('https://pan.baidu.com.evil/s/1Ab'), null);
  assert.equal(shareKey('https://evil.test/s/1Ab'), null);
});
test('filenames cannot contain filesystem paths', () => {
  assert.equal(archiveName(' bf35233.7z '), 'bf35233.7z');
  assert.equal(archiveName('../bad.zip'), null);
  assert.equal(archiveName('foo.png'), null);
});
test('purchased metadata contains source title, exact share and password notes', () => {
  const text = '隐藏内容 链接：https://pan.baidu.com/s/1Ab_C-9 提取码：abcd\n解压密码example';
  const records = parsePurchased('示例资源 bf35233', 'https://wckbot17.com/zhibo/1.html', text, []);
  assert.equal(records.length, 1);
  assert.equal(records[0].purchasedVisible, true);
  assert.equal(records[0].notes, text);
  assert.equal(records[0].title, '示例资源 bf35233');
  assert.deepEqual(parsePurchased('Title', 'source', 'Please purchase', []), []);
});
test('hidden purchased card or parent is never captured', () => {
  const make = parent => ({ hidden: false, parentElement: parent, getAttribute: () => null, getClientRects: () => [{}] });
  const parent = make(null), card = make(parent);
  const style = el => ({ display: el === parent ? 'none' : 'block', visibility: 'visible', opacity: '1' });
  assert.equal(visible(card, style), false);
  assert.equal(visible(card, () => ({ display: 'block', visibility: 'visible', opacity: '1' })), true);
  card.hidden = true;
  assert.equal(visible(card, style), false);
});

test('synchronous evidence identity equals standard SHA-256 for Unicode and image payloads', () => {
  const {createHash}=require('node:crypto');
  for (const capture of [{kind:'source',title:'示例标题',notes:'a'.repeat(100000)},{kind:'baidu',filename:'file.7z'}]) {
    assert.equal(captureID(capture),createHash('sha256').update(JSON.stringify(capture)).digest('hex'));
  }
});
test('inline PNG dimensions can be read before the image has decoded', () => {
  const fs=require('node:fs');
  const src='data:image/png;base64,'+fs.readFileSync(__dirname+'/fixtures/baidu-filename.png').toString('base64');
  assert.deepEqual(pngDimensions(src),{width:283,height:30});
  assert.equal(pngDimensions('data:image/png;base64,bad'),null);
});
