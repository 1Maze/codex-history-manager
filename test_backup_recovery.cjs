const { chromium, browserOptions } = require('./test_support.cjs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
async function main() {
  const python = spawn('python3', ['-u', '-c', `
import signal,tempfile
from pathlib import Path
from test_store import fixture
from store import ChatStore,encode
from server import LocalServer
signal.signal(signal.SIGTERM,lambda *args:(_ for _ in ()).throw(KeyboardInterrupt()))
with tempfile.TemporaryDirectory(prefix="backup-recovery-browser-") as temporary:
    home=Path(temporary)
    path,records=fixture(home)
    turn_id=records[1]["payload"]["turn_id"]
    thread_id=records[0]["payload"]["id"]
    records[3:3]=[
        {"type":"response_item","payload":{"type":"function_call","name":"functions.exec_command",
         "arguments":'{"cmd":"printf fixture"}',"call_id":"fixture-tool"}},
        {"type":"response_item","payload":{"type":"function_call_output",
         "call_id":"fixture-tool","output":"fixture output"}},
        {"type":"event_msg","payload":{"type":"item_completed","thread_id":thread_id,"turn_id":turn_id,
         "started_at_ms":1790820000001,"completed_at_ms":1790820000002,
         "item":{"type":"CommandExecution","id":"fixture-tool","command":["/bin/sh","-c","printf fixture"],
         "cwd":"file://"+str(home),"parsed_cmd":[],"source":"unified_exec_startup","status":"completed",
         "stdout":"fixture output","stderr":"","aggregated_output":"fixture output",
         "exit_code":0,"process_id":"123","duration":{"secs":0,"nanos":1000000},"formatted_output":"fixture output"}}}]
    for ordinal,record in enumerate(records):
        record["ordinal"]=ordinal
        record.setdefault("timestamp","2026-10-01T02:00:01Z")
    path.write_text("".join(encode(record)+"\\n" for record in records))
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
    const original = await page.evaluate(() => state.source);
    await page.click('#manual-backup'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && state.sync.backup);
    await page.click('#open-backups'); await page.waitForSelector('.backup-row');
    const backupId = await page.locator('.backup-row button[data-backup-id]').first().getAttribute('data-backup-id');
    await page.click('#conversation-mode');
    await page.getByRole('button', { name: '编辑第 2 条消息', exact: true }).click();
    await page.fill('.message-textarea', 'backup recovery edited reply');
    await page.getByRole('button', { name: '保存修改', exact: true }).click(); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && !dirty() && state.source.includes('backup recovery edited reply'));
    await page.click('#open-backups'); await page.waitForSelector('.backup-row');
    await page.locator(`button[data-backup-id="${backupId}"]`).click(); await page.click('#dialog-confirm');
    await page.waitForFunction((original) => !state.busy && state.source === original, original);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'backup-manager.png') });
    assert.equal(await page.locator('#recovery-mode').textContent(), '对话截选');
    assert.equal(await page.locator('#recovery-mode').getAttribute('title'), '对话截选');
    await page.click('#recovery-mode'); await page.fill('#recovery-keep', '1');
    assert.equal(await page.locator('#recovery-workspace h2').textContent(), '对话截选');
    await page.click('#preview-recovery');
    await page.waitForFunction(() => !state.busy && local.recoveryPlan);
    assert.equal(await page.evaluate(() => local.recoveryPlan.selectedTurns), 1);
    assert.equal(await page.inputValue('#recovery-copy-mode'), 'conversation');
    assert.equal(await page.locator('#recovery-conversation .recovery-message.user').count(), 1);
    assert.equal(await page.locator('#recovery-conversation .recovery-message.assistant').count(), 1);
    assert.equal(await page.locator('#recovery-conversation .recovery-message.tool').count(), 1);
    await page.locator('#recovery-conversation .recovery-message.tool summary').click();
    assert.match(await page.locator('#recovery-conversation .recovery-message.tool pre').textContent(), /fixture output/);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'conversation-recovery-tools.png') });
    assert.deepEqual(await page.locator('#recovery-copy-mode option').evaluateAll(options =>
      options.map(option => option.value)), ['conversation', 'handoff']);
    await page.selectOption('#recovery-copy-mode', { value: 'handoff' });
    assert.match(await page.inputValue('#recovery-handoff'), /fixture question/);
    await page.fill('#recovery-handoff', '目标：继续测试\n已完成：原会话数据检查\n下一步：执行下一项测试\n\n' + await page.inputValue('#recovery-handoff'));
    await page.screenshot({ path: path.join(__dirname, 'qa', 'context-recovery.png') });
    const downloadPromise = page.waitForEvent('download');
    await page.click('#export-handoff');
    assert.equal((await downloadPromise).suggestedFilename(), 'codex-handoff.md');
    await page.click('#create-recovery-copy'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && state.sync?.id !== '11111111-1111-4111-8111-111111111111', {}, { timeout: 90000 });
    assert.equal(await page.evaluate(() => state.rows[0].value.payload.history_base), undefined);
    assert.equal(await page.evaluate(() => state.rows[0].value.payload.forked_from_id), undefined);
    assert.match(await page.evaluate(() => state.source), /目标：继续测试/);
    assert.equal(await page.evaluate(() => transcript.prompts.length), 1);
    await page.evaluate(() => openChat('11111111-1111-4111-8111-111111111111'));
    assert.equal(await page.evaluate(() => state.source), original);
    await page.click('#recovery-mode');
    await page.selectOption('#recovery-copy-mode', { value: 'conversation' });
    await page.click('#preview-recovery');
    await page.waitForFunction(() => !state.busy && local.recoveryPlan);
    await page.click('#create-recovery-copy'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && state.sync?.id !== '11111111-1111-4111-8111-111111111111', {}, { timeout: 90000 });
    assert.equal(await page.evaluate(() => state.rows.filter(r => r.value?.type === 'event_msg' &&
      r.value.payload?.item?.type === 'UserMessage').length), 1);
    assert.equal(await page.evaluate(() => state.rows.filter(r => r.value?.type === 'event_msg' &&
      r.value.payload?.item?.type === 'AgentMessage').length), 1);
    assert.match(await page.evaluate(() => state.source), /original answer/);
    assert.equal(await page.evaluate(() => state.rows.filter(r => r.value?.type === 'event_msg' &&
      r.value.payload?.item?.type === 'CommandExecution').length), 1);
    assert.match(await page.evaluate(() => state.source), /fixture output/);
    assert.doesNotMatch(await page.evaluate(() => state.source), /所选完整轮次的文本摘录/);
    await page.evaluate(() => openChat('11111111-1111-4111-8111-111111111111'));
    assert.equal(await page.evaluate(() => state.source), original);
    await page.click('#recovery-mode'); await page.click('#preview-recovery');
    await page.waitForFunction(() => !state.busy && local.recoveryPlan);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => document.querySelector('#chats-panel').classList.add('collapsed'));
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(__dirname, 'qa', `context-recovery-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    console.log('PASS: backups, target-only restore, conversation preview, text handoff, structured native copy with distinct roles, original preservation, mobile.');
  } finally {
    await browser.close(); python.kill('SIGTERM'); await new Promise((resolve) => python.once('exit', resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
