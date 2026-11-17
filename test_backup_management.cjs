const { chromium, browserOptions } = require('./test_support.cjs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const python = spawn('python3', ['-u', '-c', `
import json,signal,tempfile
from pathlib import Path
from test_store import fixture,THREAD
from test_claude_store import claude_fixture,SESSION
from store import ChatStore
from claude_store import ClaudeStore
from server import LocalServer
signal.signal(signal.SIGTERM,lambda *args:(_ for _ in ()).throw(KeyboardInterrupt()))
with tempfile.TemporaryDirectory(prefix="backup-management-browser-") as temporary:
    root=Path(temporary)
    codex=root/"codex-project";codex.mkdir();fixture(codex)
    claude=root/"claude";claude.mkdir();claude_fixture(claude)
    server=LocalServer(("127.0.0.1",0),ChatStore(codex),ClaudeStore(claude,check_processes=False))
    for maintenance,identifier in ((server.recovery,THREAD),(server.claude,"project-a/"+SESSION)):
        maintenance.backup(identifier)
        maintenance.backup(identifier)
        pending=maintenance.backup(identifier)
        journal=Path(pending["backupPath"])/"journal.json"
        entry=json.loads(journal.read_text())
        entry["status"]="snapshot_preparing"
        journal.write_text(json.dumps(entry))
    print(server.origin,flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
`], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser, stderr = '';
  const exited = new Promise(resolve => python.once('exit', resolve));
  python.stderr.on('data', chunk => stderr += chunk);
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('fixture timeout')), 15000);
      python.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      python.once('exit', () => { clearTimeout(timer); reject(Error(stderr)); });
    });
    browser = await chromium.launch(browserOptions);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => local.groupsInitialized && !state.busy);
    fs.mkdirSync(path.join(__dirname, 'qa'), { recursive: true });

    for (const provider of ['codex', 'claude']) {
      await page.setViewportSize({ width: 1440, height: 900 });
      if (await page.inputValue('#provider-select') !== provider) {
        if (!await page.locator('#provider-select').isVisible()) await page.click('#toggle-chats');
        await page.selectOption('#provider-select', provider);
        await page.waitForFunction(value => local.provider === value && !state.busy, provider);
      }
      await page.evaluate(async () => {
        const sidebar = await api('/api/sidebar');
        await openChat(sidebar.groups[0].threads[0].id);
      });
      const original = await page.evaluate(() => state.source);
      await page.click('#manual-backup'); await page.click('#dialog-confirm');
      await page.waitForFunction(() => !state.busy && state.sync.backup);
      const latest = await page.evaluate(() => state.sync.backup);
      const backups = await page.evaluate(async () => (await api('/api/backups')).rows);
      const selected = backups.find(backup => backup.backupPath === latest);
      const pending = backups.find(backup => !backup.deletable);
      assert.ok(selected && pending);
      assert.equal(selected.title, provider === 'codex' ?
        'codex-project · 11111111-1111-4111-8111-111111111111 · fixture question' :
        'example · aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa · question one');
      await page.evaluate(() => {
        state.draft = '{"unsaved":"preserve this draft"}'; render();
      });
      await page.click('#open-backups');
      const remove = page.locator(`button[data-delete-backup-id="${selected.backupId}"]`);
      await remove.waitFor();
      assert.equal(await page.locator(`button[data-delete-backup-id="${pending.backupId}"]`).isDisabled(), true);
      const row = remove.locator('..');
      assert.equal(await row.locator('strong').textContent(), selected.title);
      assert.equal(await row.locator('strong').getAttribute('title'), selected.title);
      await remove.click();
      assert.match(await page.textContent('#dialog-message'), /不修改原会话或其他备份/);
      assert.ok((await page.textContent('#dialog-message')).includes(selected.title));
      await page.locator('#confirm-dialog button[value="cancel"]').click();
      assert.equal(fs.existsSync(selected.backupPath), true);
      await remove.click(); await page.keyboard.press('Escape');
      assert.equal(fs.existsSync(selected.backupPath), true);

      await page.route('**/api/backups/delete', route => route.fulfill({
        status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture deletion failed' }),
      }));
      await remove.click(); await page.click('#dialog-confirm');
      await page.waitForFunction(() => !state.busy && document.querySelector('#toast').textContent.includes('fixture deletion failed'));
      assert.equal(fs.existsSync(selected.backupPath), true);
      assert.equal(await page.evaluate(() => state.draft), '{"unsaved":"preserve this draft"}');
      await page.unroute('**/api/backups/delete');

      let release;
      const held = new Promise(resolve => { release = resolve; });
      await page.route('**/api/backups/delete', async route => { await held; await route.continue(); });
      if (provider === 'claude') {
        await page.route('**/api/backups?*', route => route.fulfill({
          status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture refresh failed' }),
        }));
      }
      await remove.click(); await page.click('#dialog-confirm');
      await page.waitForFunction(() => state.busy);
      assert.equal(await page.locator('#backup-list button:enabled').count(), 0);
      assert.equal(await page.isDisabled('#provider-select'), true);
      release();
      await page.waitForFunction(() => !state.busy && document.querySelector('#toast').textContent.includes('备份已删除'));
      await page.unroute('**/api/backups/delete');
      if (provider === 'claude') {
        assert.match(await page.textContent('#toast'), /列表刷新失败/);
        await page.unroute('**/api/backups?*');
      }
      assert.equal(await remove.count(), 0);
      assert.equal(fs.existsSync(selected.backupPath), false);
      for (const backup of backups.filter(backup => backup.backupId !== selected.backupId)) {
        assert.equal(fs.existsSync(backup.backupPath), true);
      }
      assert.equal(await page.evaluate(() => state.draft), '{"unsaved":"preserve this draft"}');
      assert.equal(await page.evaluate(() => state.source), original);
      assert.equal(await page.evaluate(() => state.sync.backup), undefined);
      assert.equal(await page.locator('#copy-backup').isHidden(), true);
      assert.equal(await page.evaluate(async () =>
        (await api('/api/open?' + new URLSearchParams({ id: state.sync.id }))).source), original);
      const rejected = await page.evaluate(async backupId => {
        try { await api('/api/backups/delete', { backupId }); return 200; }
        catch (error) { return error.status; }
      }, pending.backupId);
      assert.equal(rejected, 409);
      assert.equal(fs.existsSync(pending.backupPath), true);

      const remaining = backups.find(backup => backup.deletable && backup.backupId !== selected.backupId);
      await page.evaluate(() => { state.draft = null; render(); });
      await page.locator(`button[data-backup-id="${remaining.backupId}"]`).click();
      await page.click('#dialog-confirm');
      await page.waitForFunction(() => !state.busy && !dirty() && !!state.sync.backup, null, { timeout: 90000 });
      if (provider === 'codex') {
        assert.equal(await page.evaluate(() => state.source), original);
      } else {
        const messages = source => source.trim().split('\n').map(JSON.parse)
          .filter(record => ['user', 'assistant'].includes(record.type))
          .map(record => ({ uuid: record.uuid, parentUuid: record.parentUuid, message: record.message }));
        assert.deepEqual(messages(await page.evaluate(() => state.source)), messages(original));
      }
      await page.screenshot({ path: path.join(__dirname, 'qa', `backup-management-${provider}-desktop.png`) });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => document.querySelector('#chats-panel').classList.add('collapsed'));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const nameBox = await page.locator('.backup-row strong').first().boundingBox();
        const actionBox = await page.locator('.backup-row button').first().boundingBox();
        assert.ok(nameBox.x + nameBox.width <= actionBox.x);
        await page.screenshot({ path: path.join(__dirname, 'qa', `backup-management-${provider}-${width}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: Codex/Claude snapshot names, cancel/Esc, delete failure/success, busy/pending guards, draft and original preservation, selected-directory deletion, pointer cleanup, remaining restore, desktop/mobile.');
  } finally {
    if (browser) await browser.close();
    python.kill('SIGTERM');
    await exited;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
