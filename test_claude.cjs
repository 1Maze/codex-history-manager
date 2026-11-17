const { chromium, browserOptions } = require('./test_support.cjs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const python = spawn('python3', ['-u', '-c', `
import signal,tempfile
from pathlib import Path
from test_store import fixture
from test_claude_store import claude_fixture
from store import ChatStore
from claude_store import ClaudeStore
from server import LocalServer
signal.signal(signal.SIGTERM,lambda *args:(_ for _ in ()).throw(KeyboardInterrupt()))
with tempfile.TemporaryDirectory(prefix="claude-browser-") as temporary:
    root=Path(temporary)
    codex=root/"codex";codex.mkdir();fixture(codex)
    claude=root/"claude";claude.mkdir();claude_fixture(claude)
    server=LocalServer(("127.0.0.1",0),ChatStore(codex),ClaudeStore(claude,check_processes=False))
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
    await page.waitForFunction(() => local.groupsInitialized && !state.busy);
    await page.selectOption('#provider-select', 'claude');
    await page.waitForFunction(() => local.provider === 'claude' && !state.busy && local.groups.length === 1);
    assert.equal(await page.locator('#sqlite-mode').isVisible(), false);
    assert.equal(await page.locator('#recovery-mode').isVisible(), false);
    await page.click('#expand-all-projects');
    await page.locator('.chat-item').first().click();
    await page.waitForFunction(() => state.sync?.provider === 'claude' && !state.busy);
    assert.equal(await page.locator('.conversation-message').count(), 3);
    assert.equal(await page.evaluate(() => transcript.prompts.length), 1);
    assert.doesNotMatch(await page.locator('#message-log').innerText(), /opaque reasoning|file contents|old-hash/);
    await page.click('#manual-backup'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && state.sync.backup);
    const backups = await page.evaluate(() => api('/api/backups?' + new URLSearchParams({ id: state.sync.id })));
    const manualBackup = backups.rows.find(row => row.kind === 'manual');
    assert.ok(manualBackup);

    await page.getByRole('button', { name: '编辑第 2 条消息', exact: true }).click();
    await page.fill('.message-textarea', 'Claude edited answer');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && !dirty() && state.source.includes('Claude edited answer'));
    assert.match(await page.evaluate(() => state.source), /keep-signature|tool-one|file contents/);
    assert.doesNotMatch(await page.evaluate(() => state.source), /api-request-blob|requestRef/);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'claude-conversation.png') });

    await page.click('#jsonl-mode');
    await page.evaluate(() => {
      state.selected = state.rows.findIndex(row => row.value?.uuid === '22222222-2222-4222-8222-222222222222');
      state.view = 'record'; state.page = 0; render();
    });
    await page.click('#delete'); await page.click('#dialog-confirm');
    await page.click('#save'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && !dirty() &&
      !state.source.includes('33333333-3333-4333-8333-333333333333'));
    assert.equal(await page.evaluate(() => state.rows.find(row =>
      row.value?.uuid === '44444444-4444-4444-8444-444444444444').value.parentUuid),
      '11111111-1111-4111-8111-111111111111');
    await page.click('#open-backups');
    await page.waitForSelector(`button[data-backup-id="${manualBackup.backupId}"]`);
    await page.locator(`button[data-backup-id="${manualBackup.backupId}"]`).click();
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && !dirty() && state.source.includes('answer one'));

    await page.click('#conversation-mode');
    await page.getByRole('button', { name: '编辑第 1 条消息', exact: true }).click();
    await page.fill('.message-textarea', 'unsaved provider draft');
    await page.selectOption('#provider-select', 'codex');
    await page.locator('#confirm-dialog button[value="cancel"]').click();
    await page.waitForFunction(() => document.querySelector('#provider-select').value === 'claude');
    assert.equal(await page.inputValue('#provider-select'), 'claude');
    assert.equal(await page.inputValue('.message-textarea'), 'unsaved provider draft');
    await page.selectOption('#provider-select', 'codex');
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => local.provider === 'codex' && !state.busy);
    assert.equal(await page.evaluate(() => state.opened), false);
    assert.equal(await page.locator('#sqlite-mode').isVisible(), true);
    await page.click('#expand-all-projects');
    await page.locator('.chat-item').first().click();
    await page.waitForFunction(() => state.sync?.provider === 'codex' && !state.busy);
    assert.match(await page.evaluate(() => state.source), /original answer/);
    assert.doesNotMatch(await page.evaluate(() => state.source), /Claude edited answer/);

    await page.selectOption('#provider-select', 'claude');
    await page.waitForFunction(() => local.provider === 'claude' && !state.busy);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => document.querySelector('#chats-panel').classList.remove('collapsed'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'claude-provider-mobile.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: Claude provider selection, role filtering, signed/tool preservation, inline edits, graph-aware deletion, backups/restore, draft-safe switching, Codex isolation, mobile.');
  } finally {
    await browser.close();
    python.kill('SIGTERM');
    await new Promise(resolve => python.once('exit', resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
