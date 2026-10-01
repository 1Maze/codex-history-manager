const { chromium, browserOptions } = require('./test_support.cjs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const python = spawn('python3', ['-u', '-c', `
import signal,tempfile
from pathlib import Path
from test_store import fixture
from store import ChatStore
from server import LocalServer
signal.signal(signal.SIGTERM,lambda *args:(_ for _ in ()).throw(KeyboardInterrupt()))
with tempfile.TemporaryDirectory(prefix="inline-edit-") as temporary:
    home=Path(temporary)
    fixture(home)
    server=LocalServer(("127.0.0.1",0),ChatStore(home))
    print(server.origin,flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
`], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; python.stderr.on('data', (chunk) => stderr += chunk);
  const url = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(Error('fixture timeout')), 15000);
    python.stdout.on('data', (chunk) => { text += chunk; const match = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    python.on('exit', () => { clearTimeout(timer); reject(Error(stderr)); });
  });
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.project-toggle'); await page.click('#expand-all-projects');
    await page.locator('.chat-item').first().click(); await page.waitForFunction(() => state.sync && !state.busy);
    await page.getByRole('button', { name: '编辑第 2 条消息', exact: true }).click();
    assert.equal(await page.inputValue('.message-textarea'), 'original answer');
    assert.match(await page.textContent('.message-edit-controls'), /3 条关联记录/);
    await page.fill('.message-textarea', '**直接修改的回复**\n\n保留 Markdown。');
    assert.equal(await page.evaluate(() => dirty()), true);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'inline-message-editor.png') });
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && !dirty() && state.source.includes('直接修改的回复'));
    const copies = await page.evaluate(() => ({
      event: state.rows[3].value.payload.item.content[0].text,
      response: state.rows[4].value.payload.content[0].text,
      summary: state.rows[5].value.payload.last_agent_message,
    }));
    assert.equal(copies.event, '**直接修改的回复**\n\n保留 Markdown。');
    assert.equal(copies.event, copies.response); assert.equal(copies.event, copies.summary);
    assert.equal(await page.isVisible('#conversation-workspace'), true);
    assert.equal(await page.locator('.message-markdown strong').textContent(), '直接修改的回复');
    await page.getByRole('button', { name: '编辑第 1 条消息', exact: true }).click();
    await page.fill('.message-textarea', '新的用户发言');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.match(await page.locator('.conversation-message.user').textContent(), /fixture question/);
    assert.equal(await page.evaluate(() => dirty()), false);
    await page.getByRole('button', { name: '编辑第 1 条消息', exact: true }).click();
    await page.fill('.message-textarea', '新的用户发言');
    await page.keyboard.press('Control+s'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && !dirty() && state.source.includes('新的用户发言'));
    assert.equal(await page.locator('.prompt-snippet').textContent(), '新的用户发言');
    await page.getByRole('button', { name: '编辑第 2 条消息', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => { document.querySelector('#prompt-nav').classList.add('collapsed'); document.querySelector('#chats-panel').classList.add('collapsed'); });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: inline assistant/user edit, text copies and summary saved, native synchronization, Markdown, cancel, Ctrl+S, prompt update, mobile.');
  } finally {
    await browser.close(); python.kill('SIGTERM'); await new Promise((resolve) => python.once('exit', resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
