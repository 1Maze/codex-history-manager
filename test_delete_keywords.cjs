const { chromium, browserOptions } = require('./test_support.cjs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const python = spawn('python3', ['-u', '-c', `
import signal,tempfile
from pathlib import Path
from test_store import fixture
from test_claude_store import claude_fixture
from store import ChatStore,encode
from claude_store import ClaudeStore,serialize
from server import LocalServer
signal.signal(signal.SIGTERM,lambda *args:(_ for _ in ()).throw(KeyboardInterrupt()))
with tempfile.TemporaryDirectory(prefix="keyword-delete-browser-") as temporary:
    root=Path(temporary)
    codex=root/"codex";codex.mkdir()
    target,records=fixture(codex)
    records[3]["payload"]["item"]["content"][0]["text"]="SaFeGuArDs synthetic answer"
    records[4]["payload"]["content"][0]["text"]="SaFeGuArDs synthetic answer"
    records[5]["payload"]["last_agent_message"]="SaFeGuArDs synthetic answer"
    target.write_text("".join(encode(record)+"\\n" for record in records))
    claude=root/"claude";claude.mkdir()
    target,records=claude_fixture(claude)
    records[2]["message"]["content"][1]["text"]="CYBER synthetic answer"
    records[5]["message"]["content"][0]["text"]="CYBER synthetic answer"
    notice="Your response above was stopped by a safety classifier. Synthetic historical notice."
    records.insert(4,{"type":"user","uuid":"55555555-5555-4555-8555-555555555555",
        "parentUuid":records[3]["uuid"],"sessionId":records[1]["sessionId"],"isMeta":True,
        "refusedMessageId":"fixture-response","message":{"role":"user","content":notice}})
    records[5]["parentUuid"]="55555555-5555-4555-8555-555555555555"
    target.write_bytes(serialize(records))
    server=LocalServer(("127.0.0.1",0),ChatStore(codex),ClaudeStore(claude,check_processes=False))
    print(server.origin,flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
`], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  let stderr = '';
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
    assert.equal(await page.locator('#delete-keywords').count(), 1, 'keyword deletion action exists');
    assert.equal(await page.isDisabled('#delete-keywords'), true);
    assert.equal(await page.locator('#delete-keywords svg').count(), 1);
    await page.evaluate(async () => {
      window.originalRows = Array.from({ length: 165 }, (_, id) => ({
        id, type: id === 80 ? 'visible' : 'hidden', text: id === 1 ? 'SaFeGuArDs example' :
          id === 81 ? 'cybersecurity example' : id === 164 ? 'CYBER example' : 'ordinary text',
      }));
      window.fileContent = originalRows.map(row => JSON.stringify(row) + '\r\n').join('');
      window.fileWrites = 0;
      window.testHandle = {
        name: 'keywords.jsonl',
        getFile: async () => new File([fileContent], 'keywords.jsonl'),
        isSameEntry: async other => other === testHandle,
        createWritable: async () => {
          let text = '';
          return { write: async value => { text = value; },
            close: async () => { fileContent = text; fileWrites++; }, abort: async () => {} };
        },
      };
      await readFile(await testHandle.getFile(), testHandle);
      state.selected = 80; render();
    });
    await page.selectOption('#type-filter', 'value:"visible"');
    await page.fill('#search', '"id":80');
    const original = await page.evaluate(() => state.source);
    await page.click('#delete-keywords');
    assert.match(await page.textContent('#dialog-message'), /3 条/);
    assert.match(await page.textContent('#dialog-message'), /safeguards.*cyber/i);
    assert.match(await page.textContent('#dialog-message'), /第 165 行/);
    fs.mkdirSync(path.join(__dirname, 'qa'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, 'qa', 'delete-keywords-desktop.png') });
    await page.locator('#confirm-dialog button[value="cancel"]').click();
    assert.equal(await page.evaluate(() => state.source), original);
    await page.click('#delete-keywords'); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => state.source), original);
    await page.click('#delete-keywords'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.rows.length === 162);
    assert.equal(await page.evaluate(() => state.rows[state.selected].value.id), 80);
    assert.equal(await page.evaluate(() => fileWrites), 0);
    assert.equal(await page.evaluate(() => state.rows.every(row => row.eol === '\r\n')), true);
    assert.equal(await page.evaluate(() => dirty()), true);
    await page.click('#undo');
    assert.equal(await page.evaluate(() => state.source), original);
    await page.click('#redo');
    assert.equal(await page.evaluate(() => state.rows.length), 162);
    await page.click('#save');
    await page.waitForFunction(() => fileWrites === 1);
    assert.equal(await page.evaluate(() => fileContent), await page.evaluate(() => state.source));
    await page.click('#delete-keywords');
    assert.equal(await page.locator('#confirm-dialog').evaluate(dialog => dialog.open), false);
    assert.match(await page.textContent('#toast'), /没有/);

    await page.evaluate(async () => {
      const notice = 'Your response above was stopped by a safety classifier. Synthetic historical notice.';
      const records = [
        { type: 'user', uuid: 'visible', message: { role: 'user', content: 'ordinary question' } },
        { type: 'user', uuid: 'hidden-string', isMeta: true, message: { role: 'user', content: notice } },
        { type: 'user', uuid: 'hidden-blocks', isMeta: true, message: { role: 'user',
          content: [{ type: 'text', text: notice }] } },
        { type: 'user', uuid: 'other-meta', isMeta: true, message: { role: 'user', content: 'keep this context' } },
        { type: 'assistant', uuid: 'quote', message: { role: 'assistant', content: notice } },
        { type: 'user', uuid: 'tool-quote', message: { role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'quoted-result', content: notice }] } },
        { type: 'user', uuid: 'visible-quote', message: { role: 'user', content: notice } },
        { type: 'user', uuid: 'meta-quote', isMeta: true, message: { role: 'user',
          content: 'A quoted historical explanation: ' + notice } },
        { type: 'user', uuid: 'meta-tool-quote', isMeta: true, message: { role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'hidden-quoted-result', content: notice }] } },
      ];
      await readFile(new File([records.map(row => JSON.stringify(row) + '\n').join('')], 'hidden-notices.jsonl'));
    });
    assert.deepEqual(await page.evaluate(() => keywordDeletionTargets().map(target => target.index)), [1, 2]);
    assert.equal(await page.locator('.conversation-message').count(), 3);
    await page.click('#delete-keywords');
    assert.match(await page.textContent('#dialog-message'), /隐藏提示 2 条/);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'delete-hidden-notices-desktop.png') });
    await page.locator('#confirm-dialog button[value="cancel"]').click();
    assert.equal(await page.evaluate(() => state.rows.length), 9);
    await page.click('#delete-keywords'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.rows.length === 7);
    assert.deepEqual(await page.evaluate(() => state.rows.map(row => row.value.uuid)),
      ['visible', 'other-meta', 'quote', 'tool-quote', 'visible-quote', 'meta-quote', 'meta-tool-quote']);
    await page.click('#jsonl-mode');
    await page.click('#undo');
    assert.equal(await page.evaluate(() => state.rows.length), 9);
    await page.click('#redo');
    assert.equal(await page.evaluate(() => state.rows.length), 7);

    await page.evaluate(async () => {
      await readFile(new File(['{"text":"ordinary"}\n{"text":"safe"}\n'], 'draft.jsonl'));
      state.selected = 1; render();
    });
    await page.fill('#editor', '{"text":"CYBER unsaved draft"}');
    await page.click('#delete-keywords');
    assert.match(await page.textContent('#dialog-message'), /1 条/);
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.rows.length === 1);
    await page.click('#undo');
    assert.match(await page.evaluate(() => state.source), /CYBER unsaved draft/);
    await page.fill('#editor', '{broken');
    await page.click('#delete-keywords');
    assert.equal(await page.locator('#confirm-dialog').evaluate(dialog => dialog.open), false);
    assert.equal(await page.inputValue('#editor'), '{broken');
    await page.click('#undo');
    await page.click('#source-tab');
    await page.fill('#editor', '{"text":"\\u0063yber escaped"}\r\n{"text":"keep"}\r\n');
    await page.click('#delete-keywords');
    assert.match(await page.textContent('#dialog-message'), /1 条/);
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.source === '{"text":"keep"}\n');

    await page.evaluate(async () => {
      const records = [{ type: 'session_meta', payload: { id: 'fixture', note: 'safeguards' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'CYBER remove' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'keep' } }];
      const inherited = [{ source: '{"type":"event_msg","payload":{"type":"agent_message","message":"cyber inherited"}}\n' }];
      await readFile(new File([records.map(row => JSON.stringify(row) + '\n').join('')], 'linked.jsonl'),
        null, { id: 'fixture', inherited });
    });
    await page.click('#delete-keywords');
    assert.match(await page.textContent('#dialog-message'), /1 条/);
    assert.match(await page.textContent('#dialog-message'), /session_meta/);
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.rows.length === 2);
    assert.equal(await page.evaluate(() => state.rows[0].value.type), 'session_meta');
    assert.match(await page.evaluate(() => state.sync.inherited[0].source), /cyber inherited/);
    await page.evaluate(() => { state.busy = true; renderStatus(); });
    assert.equal(await page.isDisabled('#delete-keywords'), true);
    await page.evaluate(() => { state.busy = false; renderStatus(); });

    for (const provider of ['codex', 'claude']) {
      await page.evaluate(() => { state.baseline = state.source; });
      if (provider !== await page.inputValue('#provider-select')) {
        await page.selectOption('#provider-select', provider);
        await page.waitForFunction(value => local.provider === value && !state.busy, provider);
      }
      await page.evaluate(async () => {
        const data = await api('/api/sidebar');
        await openChat(data.groups[0].threads[0].id);
      });
      const before = await page.evaluate(() => state.source);
      const id = await page.evaluate(() => state.sync.id);
      if (provider === 'claude') {
        await page.getByRole('button', { name: '编辑第 2 条消息', exact: true }).click();
        await page.fill('.message-textarea', 'CYBER edited before deletion');
      }
      await page.click('#delete-keywords');
      if (provider === 'claude') assert.match(await page.textContent('#dialog-message'), /隐藏提示 1 条/);
      await page.click('#dialog-confirm');
      await page.waitForFunction(() => dirty() && !document.querySelector('#confirm-dialog').open);
      assert.equal(await page.evaluate(async identifier =>
        (await api('/api/open?' + new URLSearchParams({ id: identifier }))).source, id), before);
      await page.click('#save'); await page.click('#dialog-confirm');
      await page.waitForFunction(() => !state.busy && !dirty(), null, { timeout: 90000 });
      const after = await page.evaluate(() => state.source);
      assert.doesNotMatch(after, /safeguards|cyber/i);
      const backupPath = await page.evaluate(() => state.sync.backup);
      assert.ok(backupPath);
      assert.equal(fs.readFileSync(path.join(backupPath,
        provider === 'codex' ? 'rollout.before.jsonl' : 'before-0.bin'), 'utf8'), before);
      assert.match(after, provider === 'codex' ? /fixture question/ : /question one/);
      if (provider === 'claude') {
        assert.doesNotMatch(after, /tool-one|file contents/);
        assert.doesNotMatch(after, /stopped by a safety classifier|fixture-response/);
        assert.match(after, /final answer/);
        assert.equal(await page.evaluate(() => state.rows.find(row =>
          row.value.uuid === '44444444-4444-4444-8444-444444444444').value.parentUuid),
          '11111111-1111-4111-8111-111111111111');
      }
    }
    await page.evaluate(async () => {
      await readFile(new File(['{"text":"safeguards <img src=x onerror=alert(1)>"}\n'], 'mobile.jsonl'));
      document.querySelector('#chats-panel').classList.add('collapsed');
    });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.click('#delete-keywords');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('#dialog-message img').count(), 0);
      const box = await page.locator('#confirm-dialog').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 844);
      await page.screenshot({ path: path.join(__dirname, 'qa', `delete-keywords-mobile-${width}.png`) });
      await page.keyboard.press('Escape');
    }
    await page.click('#delete-keywords'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.rows.length === 0);
    assert.equal(await page.isDisabled('#delete-keywords'), true);
    await page.evaluate(() => history('undo'));
    assert.equal(await page.evaluate(() => state.rows.length), 1);
    await page.click('#delete-keywords');
    await page.evaluate(() => applySource('{"text":"changed while confirming"}\n'));
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('重新确认'));
    assert.match(await page.evaluate(() => state.source), /changed while confirming/);
    assert.match(await page.textContent('#toast'), /重新确认/);
    assert.deepEqual(errors, []);
    console.log('PASS: keywords and hidden notices, quotation/metadata preservation, cross-page/filter deletion, cancel/Esc, drafts, escaped JSON, undo/redo, CRLF save, metadata/inheritance protection, Codex/Claude chain repair, backup and save, mobile.');
  } finally {
    if (browser) await browser.close();
    python.kill('SIGTERM');
    await exited;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
