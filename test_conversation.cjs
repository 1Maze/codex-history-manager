const { chromium, browserOptions } = require('./test_support.cjs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const python = spawn('python3', ['-u', '-c', `
import copy, signal, tempfile
from pathlib import Path
from test_store import fixture, THREAD
from store import ChatStore, connect, encode
from server import LocalServer
signal.signal(signal.SIGTERM, lambda *args: (_ for _ in ()).throw(KeyboardInterrupt()))
with tempfile.TemporaryDirectory(prefix="chat-conversation-") as temporary:
    home=Path(temporary)
    file, original=fixture(home)
    context={"type":"response_item","payload":{"type":"message","role":"user","id":"injected-context","content":[{"type":"input_text","text":"<environment_context>hidden environment</environment_context>"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["environments.environment_context"]}}}
    tool={"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"hidden-tool","command":"hidden tool output"}}}
    prompt=copy.deepcopy(original[2])
    prompt["payload"]["item"]["id"]="user-two"
    prompt["payload"]["item"]["content"][0]["text"]="第二次发言：跳转和编辑"
    reply=copy.deepcopy(original[3])
    reply["payload"]["item"]["id"]="agent-two"
    reply["payload"]["item"]["content"][0]["text"]="**第二次回复**\\n\\n正常展示 \`code\`。\\n\\n<script>window.badMarkup=1</script>\\n\\n![hidden](https://tracker.invalid/pixel)\\n\\n"+"长回复 "*600
    duplicate=copy.deepcopy(original[4])
    duplicate["payload"]["id"]="agent-two"
    duplicate["payload"]["content"][0]["text"]=reply["payload"]["item"]["content"][0]["text"]
    records=original[:3]+[context,tool]+original[3:5]+[prompt,reply,duplicate]
    for index, record in enumerate(records): record["ordinal"]=index
    file.write_text("".join(encode(record)+"\\n" for record in records),encoding="utf-8")
    branch="33333333-3333-4333-8333-333333333333"
    meta=copy.deepcopy(records[0])
    meta["ordinal"]=len(records)
    meta["payload"].update(id=branch,session_id=branch,history_base={"thread_id":THREAD,"end_ordinal_exclusive":len(records),"end_byte_offset":file.stat().st_size})
    branch_file=file.parent/("rollout-2026-10-01T10-01-00-"+branch+".jsonl")
    branch_file.write_text(encode(meta)+"\\n",encoding="utf-8")
    with connect(home/"state_5.sqlite") as db:
        metadata=dict(db.execute("SELECT * FROM threads WHERE id=?",(THREAD,)).fetchone())
        metadata.update(id=branch,rollout_path=str(branch_file),name="继承对话测试")
        names=list(metadata)
        db.execute("INSERT INTO threads ("+",".join(names)+") VALUES ("+",".join("?" for _ in names)+")",[metadata[name] for name in names])
    server=LocalServer(("127.0.0.1",0),ChatStore(home))
    print(server.origin,flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
`], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; python.stderr.on('data', (chunk) => stderr += chunk);
  const url = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(Error('Fixture timeout')), 15000);
    python.stdout.on('data', (chunk) => {
      text += chunk; const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    python.on('exit', (code) => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${stderr}`)); });
  });
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], remoteRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (!request.url().startsWith(url)) remoteRequests.push(request.url()); });
    await page.goto(url); await page.waitForSelector('.project-toggle'); await page.click('#expand-all-projects');
    await page.locator('.chat-item[data-thread-id="11111111-1111-4111-8111-111111111111"]').click();
    await page.waitForFunction(() => state.sync && !state.busy);
    assert.equal(await page.isVisible('#conversation-workspace'), true);
    assert.equal(await page.locator('.conversation-message').count(), 4);
    assert.equal(await page.locator('.prompt-entry').count(), 2);
    assert.equal(await page.locator('.rail-dot').count(), 2);
    assert.doesNotMatch(await page.textContent('#message-log'), /hidden environment|hidden tool output/);
    assert.equal(await page.locator('#message-log strong').last().textContent(), '第二次回复');
    assert.equal(await page.locator('#message-log script, #message-log img').count(), 0);
    assert.equal(await page.evaluate(() => window.badMarkup), undefined);
    await page.locator('.message-expand').click();
    assert.equal(await page.locator('.message-expand').textContent(), '收起');
    await page.locator('.message-expand').click();
    await page.fill('#prompt-search', '第二次');
    assert.equal(await page.locator('.prompt-entry').count(), 1);
    await page.locator('.prompt-jump').click();
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.conversation-message.user').last().getAttribute('data-source-line'), '8');
    await page.getByRole('button', { name: '定位第 2 条发言的原始数据', exact: true }).click();
    assert.equal(await page.isVisible('#jsonl-workspace'), true);
    assert.equal(await page.evaluate(() => state.selected), 7);
    const record = JSON.parse(await page.inputValue('#editor'));
    assert.equal(record.payload.item.id, 'user-two');
    record.payload.item.content[0].text = '第二次发言已修改';
    await page.fill('#editor', JSON.stringify(record, null, 2));
    await page.click('#conversation-mode');
    assert.match(await page.locator('.conversation-message.user').last().textContent(), /第二次发言已修改/);
    await page.locator('.rail-dot').last().hover();
    await page.waitForFunction(() => !document.querySelector('#prompt-hover').hidden);
    assert.match(await page.textContent('#prompt-hover-text'), /第二次发言已修改/);
    assert.match(await page.textContent('#prompt-hover-reply'), /第二次回复/);
    await page.click('#prompt-hover-source');
    assert.equal(await page.evaluate(() => state.selected), 7);
    await page.click('#conversation-mode'); await page.fill('#prompt-search', '');
    await page.mouse.move(700, 180); await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'conversation-desktop.png') });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => { document.querySelector('#prompt-nav').classList.add('collapsed'); document.querySelector('#chats-panel').classList.add('collapsed'); });
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(__dirname, 'qa', `conversation-mobile-${width}.png`) });
    }
    const inherited = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    inherited.on('pageerror', (error) => errors.push(error.message));
    await inherited.goto(url);
    await inherited.waitForSelector('.project-toggle'); await inherited.click('#expand-all-projects');
    await inherited.locator('.chat-item[data-thread-id="33333333-3333-4333-8333-333333333333"]').click();
    await inherited.waitForFunction(() => state.sync && !state.busy);
    assert.equal(await inherited.locator('.conversation-message').count(), 4);
    assert.equal(await inherited.locator('.prompt-entry').count(), 2);
    assert.equal(await inherited.evaluate(() => state.rows.length), 1);
    await inherited.getByRole('button', { name: '定位第 2 条发言的原始数据', exact: true }).click();
    await inherited.waitForFunction(() => state.sync?.id === '11111111-1111-4111-8111-111111111111' && !state.busy && local.mode === 'jsonl');
    assert.equal(await inherited.evaluate(() => state.selected), 7);
    assert.match(await inherited.inputValue('#editor'), /user-two/);
    assert.deepEqual(remoteRequests, []);
    assert.deepEqual(errors, []);
    console.log('PASS: conversation, canonical replies, prompt search/jump, raw row mapping, draft refresh, hover, expand/collapse, safe Markdown, desktop/mobile, inherited source navigation.');
  } finally {
    await browser.close(); python.kill('SIGTERM');
    await new Promise((resolve) => python.once('exit', resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
