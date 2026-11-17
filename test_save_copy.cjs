const { chromium, browserOptions } = require('./test_support.cjs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const python = spawn('python3', ['-u', '-c', `
import fcntl,signal,tempfile
from pathlib import Path
from test_store import fixture,THREAD,TURN
from store import ChatStore,encode
from server import LocalServer
signal.signal(signal.SIGTERM,lambda *args:(_ for _ in ()).throw(KeyboardInterrupt()))
with tempfile.TemporaryDirectory(prefix="save-copy-browser-") as temporary:
    home=Path(temporary)
    path,records=fixture(home)
    records[3:3]=[
        {"type":"response_item","payload":{"type":"function_call","name":"functions.exec_command",
         "arguments":'{"cmd":"printf fixture"}',"call_id":"fixture-tool"}},
        {"type":"response_item","payload":{"type":"function_call_output",
         "call_id":"fixture-tool","output":"fixture output"}},
        {"type":"event_msg","payload":{"type":"item_completed","thread_id":THREAD,"turn_id":TURN,
         "started_at_ms":1790820000001,"completed_at_ms":1790820000002,
         "item":{"type":"CommandExecution","id":"fixture-tool","command":["/bin/sh","-c","printf fixture"],
         "cwd":"file://"+str(home),"parsed_cmd":[],"source":"unified_exec_startup","status":"completed",
         "stdout":"fixture output","stderr":"","aggregated_output":"fixture output",
         "exit_code":0,"process_id":"123","duration":{"secs":0,"nanos":1000000},"formatted_output":"fixture output"}}}]
    for ordinal,record in enumerate(records):
        record["ordinal"]=ordinal
        record.setdefault("timestamp","2026-10-01T02:00:01Z")
    path.write_text("".join(encode(record)+"\\n" for record in records))
    locks=home/"thread-writer-locks"
    locks.mkdir()
    with (locks/(THREAD+".lock")).open("a+b") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        server=LocalServer(("127.0.0.1",0),ChatStore(home))
        print(server.origin,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close()
`], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  python.stderr.on('data', chunk => stderr += chunk);
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('fixture timeout')), 15000);
    python.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    python.on('exit', () => { clearTimeout(timer); reject(Error(stderr)); });
  });
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForSelector('.project-toggle');
    await page.click('#expand-all-projects');
    await page.locator('.chat-item').first().click();
    await page.waitForFunction(() => state.sync && !state.busy);
    const originalId = await page.evaluate(() => state.sync.id);
    const original = await page.evaluate(() => state.source);
    await page.getByRole('button', { name: '编辑第 2 条消息', exact: true }).click();
    await page.fill('.message-textarea', 'draft saved independently');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => document.querySelector('#dialog-confirm').textContent === '保存独立副本');
    assert.match(await page.locator('#confirm-dialog').textContent(), /同步失败/);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'save-copy-dialog.png') });
    await page.locator('#confirm-dialog button[value="cancel"]').click();
    await page.waitForFunction(() => !state.busy);
    assert.equal(await page.evaluate(() => dirty()), true);
    assert.equal(await page.evaluate(() => state.sync.id), originalId);
    assert.match(await page.evaluate(() => state.source), /draft saved independently/);
    await page.click('#save'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => document.querySelector('#dialog-confirm').textContent === '保存独立副本');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !state.busy);
    assert.equal(await page.evaluate(() => state.sync.id), originalId);
    assert.equal(await page.evaluate(() => dirty()), true);

    await page.route('**/api/save', route => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: 'SQLite 已被外部修改' }),
    }));
    await page.click('#save');
    const saveFailure = page.waitForResponse('**/api/save');
    await page.click('#dialog-confirm');
    await saveFailure;
    await page.waitForFunction(() => !state.busy);
    assert.equal(await page.locator('#confirm-dialog').evaluate(dialog => dialog.open), false);
    assert.equal(await page.evaluate(() => dirty()), true);
    await page.unroute('**/api/save');

    await page.route('**/api/copy', route => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'copy fixture failure' }),
    }));
    await page.click('#save'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => document.querySelector('#dialog-confirm').textContent === '保存独立副本');
    const copyFailure = page.waitForResponse('**/api/copy');
    await page.click('#dialog-confirm');
    await copyFailure;
    await page.waitForFunction(() => !state.busy);
    assert.equal(await page.evaluate(() => state.sync.id), originalId);
    assert.equal(await page.evaluate(() => dirty()), true);
    assert.match(await page.evaluate(() => state.source), /draft saved independently/);
    await page.unroute('**/api/copy');

    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => document.querySelector('#chats-panel').classList.add('collapsed'));
    await page.click('#save'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => document.querySelector('#dialog-confirm').textContent === '保存独立副本');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'save-copy-dialog-mobile.png') });
    await page.click('#dialog-confirm');
    await page.waitForFunction(id => !state.busy && state.sync.id !== id && !dirty(),
      originalId, { timeout: 90000 });
    const copyId = await page.evaluate(() => state.sync.id);
    const copied = await page.evaluate(() => state.source);
    assert.match(copied, /draft saved independently/);
    assert.doesNotMatch(copied, /original answer/);
    assert.match(copied, /fixture output/);
    assert.equal(await page.evaluate(() => transcript.prompts.length), 1);
    assert.equal(await page.locator('.conversation-message').count(), 2);
    assert.equal(await page.evaluate(() => state.rows[0].value.payload.history_base), undefined);
    const originalNow = await page.evaluate(async id =>
      (await api('/api/open?' + new URLSearchParams({ id }))).source, originalId);
    assert.equal(originalNow, original);
    const items = await page.evaluate(async id =>
      (await api('/api/table?' + new URLSearchParams({ id, table: 'thread_items' }))).rows, copyId);
    assert.deepEqual(items.map(item => item.item_type).sort(),
      ['agentMessage', 'commandExecution', 'userMessage'].sort());
    assert.deepEqual(errors, []);
    console.log('PASS: real writer-lock fallback, cancel preserves draft, unrelated errors, failed copy preserves draft, independent edited roles/tools, original unchanged, mobile.');
  } finally {
    await browser.close();
    python.kill('SIGTERM');
    await new Promise(resolve => python.once('exit', resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
