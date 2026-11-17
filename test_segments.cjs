const { chromium, browserOptions } = require('./test_support.cjs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const python = spawn('python3', ['-u', '-c', `
import signal,tempfile,json
from pathlib import Path
from test_store import segmented_fixture
from store import ChatStore,connect,encode
from server import LocalServer
signal.signal(signal.SIGTERM,lambda *args:(_ for _ in ()).throw(KeyboardInterrupt()))
with tempfile.TemporaryDirectory(prefix="segmented-browser-") as temporary:
    home=Path(temporary)
    paths=segmented_fixture(home)
    legacy_id="99999999-9999-4999-8999-999999999999"
    branch_id="33333333-3333-4333-8333-333333333333"
    legacy=[json.loads(line) for line in paths[0].read_text().splitlines()]
    legacy[0]["payload"].update(id=legacy_id,session_id=legacy_id)
    for record in legacy[1:]:
        if "thread_id" in record["payload"]:record["payload"]["thread_id"]=legacy_id
    legacy_path=home/"sessions"/("rollout-"+legacy_id+".jsonl")
    legacy_path.write_text("".join(encode(record)+"\\n" for record in legacy))
    branch=json.loads(encode(legacy[0]))
    branch["payload"].update(id=branch_id,session_id=branch_id,history_base={
        "thread_id":legacy_id,"end_ordinal_exclusive":6,"end_byte_offset":legacy_path.stat().st_size})
    branch["ordinal"]=6
    branch_path=home/"sessions"/("rollout-"+branch_id+".jsonl")
    branch_path.write_text(encode(branch)+"\\n")
    with connect(home/"state_5.sqlite") as db:
        template=dict(db.execute("SELECT * FROM threads").fetchone())
        for identifier,file,title in [(legacy_id,legacy_path,"旧版父会话"),(branch_id,branch_path,"普通分支")]:
            row={**template,"id":identifier,"rollout_path":str(file),"title":title,"name":title}
            names=list(row)
            db.execute("INSERT INTO threads ("+",".join('"'+name+'"' for name in names)+") VALUES ("+
                ",".join("?" for _ in names)+")",[row[name] for name in names])
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
    await page.locator('.chat-item[data-thread-id="11111111-1111-4111-8111-111111111111"]').click();
    await page.waitForFunction(() => state.sync && !state.busy);
    assert.equal(await page.locator('.conversation-message').count(), 6);
    assert.equal(await page.evaluate(() => transcript.prompts.length), 3);
    assert.equal(await page.evaluate(() => transcript.messages.filter(m => m.readOnly).length), 4);
    assert.equal(await page.evaluate(() => new Set(transcript.messages.map(m => m.key)).size), 6);
    const source = await page.evaluate(() => state.source);
    const parents = await page.evaluate(() => state.sync.inherited.map(s => s.source));

    await page.getByRole('button', { name: '编辑第 2 条消息', exact: true }).click();
    assert.equal(await page.locator('.message-textarea').count(), 0);
    assert.equal(await page.evaluate(() => state.source), source);
    await page.getByRole('button', { name: '查看第 1 条消息的原始数据', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#history-source-dialog').open);
    assert.match(await page.locator('#history-source-data').textContent(), /fixture question/);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'segment-history-source.png') });
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'segment-history-source-mobile.png') });
    await page.getByRole('button', { name: '关闭历史数据', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByRole('button', { name: '编辑第 6 条消息', exact: true }).click();
    await page.fill('.message-textarea', 'edited current segment');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && !dirty() && state.source.includes('edited current segment'));
    assert.equal(await page.evaluate(() => state.sync.info.health), 'aligned');
    assert.equal(await page.evaluate(() => state.sync.info.historyId), '77777777-7777-4777-8777-777777777777');
    assert.deepEqual(await page.evaluate(() => state.sync.inherited.map(s => s.source)), parents);
    const items = await page.evaluate(async () => (await api('/api/table?' +
      new URLSearchParams({ id: state.sync.id, table: 'thread_items' }))).rows);
    assert.equal(items.length, 2);
    assert.ok(items.every(item => item.thread_id === '77777777-7777-4777-8777-777777777777'));
    await page.evaluate(() => openChat('33333333-3333-4333-8333-333333333333'));
    await page.waitForFunction(() => !state.busy && state.sync.id === '33333333-3333-4333-8333-333333333333');
    assert.equal(await page.evaluate(() => transcript.messages.filter(m => m.readOnly).length), 0);
    await page.getByRole('button', { name: '编辑第 2 条消息', exact: true }).click();
    assert.match(await page.locator('#dialog-title').textContent(), /编辑父会话/);
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => !state.busy && state.sync.id === '99999999-9999-4999-8999-999999999999' &&
      document.querySelector('.message-textarea'));
    assert.equal(await page.inputValue('.message-textarea'), 'original answer');
    assert.deepEqual(errors, []);
    console.log('PASS: segmented-history display, distinct message keys, read-only history inspection, current-segment editing, physical-index isolation, unchanged ancestors, editable legacy parents, mobile.');
  } finally {
    await browser.close();
    python.kill('SIGTERM');
    await new Promise(resolve => python.once('exit', resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
