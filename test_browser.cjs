const { chromium, browserOptions } = require('./test_support.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const python = spawn('python3', ['-u', '-c', `
import signal, tempfile
from pathlib import Path
from test_store import fixture
from store import ChatStore
from server import LocalServer
signal.signal(signal.SIGTERM, lambda *args: (_ for _ in ()).throw(KeyboardInterrupt()))
with tempfile.TemporaryDirectory(prefix="chat-sync-browser-") as temporary:
    home=Path(temporary)
    fixture(home)
    server=LocalServer(("127.0.0.1",0),ChatStore(home))
    print(server.origin,flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
`], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  python.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Fixture server timeout')), 15000);
    python.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    python.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${stderr}`)); });
  });
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForSelector('.project-toggle');
    assert.equal(await page.locator('.project-group').count(), 1);
    assert.equal(await page.locator('.chat-item').count(), 0);
    await page.locator('.project-toggle').click();
    assert.equal(await page.locator('.chat-item').first().textContent(), '同步测试聊天');
    assert.equal(await page.locator('.chat-item').first().locator('span, small, strong').count(), 0);
    await page.locator('.project-toggle').click();
    assert.equal(await page.locator('.chat-item').count(), 0);
    await page.locator('.project-toggle').click();
    await page.fill('#chat-search', '同步测试');
    await page.waitForFunction(() => local.sidebarQuery === '同步测试');
    await page.locator('.project-toggle').click();
    assert.equal(await page.locator('.chat-item').count(), 0);
    await page.locator('.project-toggle').click();
    await page.fill('#chat-search', '');
    await page.waitForFunction(() => local.sidebarQuery === '');
    await page.locator('.chat-item').first().click();
    await page.waitForFunction(() => state.sync && state.rows.length === 6 && !state.busy);
    assert.equal(await page.isVisible('#conversation-workspace'), true);
    assert.equal(await page.locator('.conversation-message').count(), 2);
    assert.equal(await page.locator('.prompt-entry').count(), 1);
    assert.equal(await page.textContent('#index-health'), '尚无索引');
    await page.click('#repair-index'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && document.querySelector('#index-health').textContent === '偏移一致');
    await page.click('#sqlite-mode');
    await page.selectOption('#db-table', 'thread_items');
    await page.waitForFunction(() => document.querySelector('#db-count').textContent === '2 行');
    await page.locator('#db-grid tbody tr').last().click();
    assert.match(await page.textContent('#db-row-detail'), /original answer/);
    await page.click('#locate-event');
    assert.equal(await page.isVisible('#jsonl-workspace'), true);
    assert.match(await page.inputValue('#editor'), /AgentMessage/);
    await page.selectOption('#type-filter', 'value:"response_item"');
    await page.locator('.record-item').click();
    const value = JSON.parse(await page.inputValue('#editor'));
    value.payload.content[0].text = '浏览器同步修改';
    await page.fill('#editor', JSON.stringify(value, null, 2));
    await page.click('#save'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && state.baseline.includes('浏览器同步修改') && !dirty());
    assert.match(await page.textContent('#toast'), /联动 2 条/);
    await page.click('#sqlite-mode');
    await page.selectOption('#db-table', 'thread_items');
    await page.waitForFunction(() => document.querySelector('#db-count').textContent === '2 行');
    await page.locator('#db-grid tbody tr').last().click();
    assert.match(await page.textContent('#db-row-detail'), /浏览器同步修改/);
    await page.selectOption('#db-table', 'thread_history_projection_state');
    await page.waitForFunction(() => document.querySelector('#db-count').textContent === '1 行');
    await page.locator('#db-grid tbody tr').first().click();
    assert.match(await page.textContent('#db-row-detail'), /next_rollout_byte_offset/);
    fs.mkdirSync(path.join(__dirname, 'qa'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, 'qa', 'sqlite-desktop.png') });
    await page.click('#jsonl-mode');
    await page.selectOption('#type-filter', '');
    await page.locator('.record-item[title="第 3 行"]').click();
    await page.click('#delete-after'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.rows.length === 3);
    assert.equal(await page.textContent('#count'), '3');
    await page.click('#undo');
    assert.equal(await page.textContent('#count'), '6');
    await page.click('#redo');
    assert.equal(await page.textContent('#count'), '3');
    await page.click('#save'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && !dirty() && state.rows.length === 3);
    await page.click('#sqlite-mode');
    await page.selectOption('#db-table', 'thread_items');
    await page.waitForFunction(() => document.querySelector('#db-count').textContent === '1 行');
    assert.doesNotMatch(await page.textContent('#db-grid'), /agent-one/);
    await page.click('#jsonl-mode');
    await page.screenshot({ path: path.join(__dirname, 'qa', 'jsonl-desktop.png') });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => document.querySelector('#chats-panel').classList.add('collapsed'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(__dirname, 'qa', `jsonl-mobile-${width}.png`) });
      await page.click('#sqlite-mode');
      await page.waitForFunction(() => document.querySelector('#db-count').textContent === '1 行');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(__dirname, 'qa', `sqlite-mobile-${width}.png`) });
      await page.click('#jsonl-mode');
    }
    const missingToken = await page.request.get(url + '/api/threads');
    assert.equal(missingToken.status(), 403);
    const crossOrigin = await page.request.post(url + '/api/save', {
      headers: { Origin: 'https://untrusted.example', 'X-Chat-Sync-Token': await page.evaluate(() => local.token) },
      data: {},
    });
    assert.equal(crossOrigin.status(), 403);
    const rebinding = await page.request.get(url + '/api/bootstrap', { headers: { Host: 'attacker.invalid' } });
    assert.equal(rebinding.status(), 403);
    assert.deepEqual(errors, []);
    console.log('PASS: project grouping, title-only rows, folder collapse/search, native synchronization, SQLite row navigation, linked edits, deletion, undo/redo, desktop/mobile, security.');
  } finally {
    await browser.close();
    python.kill('SIGTERM');
    await new Promise((resolve) => python.once('exit', resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
