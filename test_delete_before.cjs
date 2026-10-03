const { chromium, browserOptions } = require('./test_support.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
async function run() {
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:5189');
    await page.evaluate(async () => {
      window.fileContent = [1, 2, 3, 4].map((id) => JSON.stringify({ id, type: id === 3 ? 'keep' : 'other' }) + '\r\n').join('');
      window.fileWrites = 0;
      window.testHandle = {
        name: 'test.jsonl',
        getFile: async () => new File([fileContent], 'test.jsonl'),
        isSameEntry: async (other) => other === testHandle,
        createWritable: async () => {
          let text = '';
          return { write: async (value) => { text = value; }, close: async () => { fileContent = text; fileWrites++; }, abort: async () => {} };
        },
      };
      await readFile(await testHandle.getFile(), testHandle);
    });
    assert.equal(await page.isDisabled('#delete-before'), true);
    assert.equal(await page.locator('#delete-before svg').count(), 1);
    await page.selectOption('#type-filter', 'value:"keep"');
    await page.locator('.record-item').click();
    await page.fill('#editor', '{"id":3,"type":"keep","changed":true}');
    await page.click('#delete-before');
    assert.match(await page.textContent('#dialog-message'), /第 1 至 2 行，共 2 条/);
    await page.locator('#confirm-dialog button[value="cancel"]').click();
    assert.equal(await page.textContent('#count'), '4');
    assert.match(await page.inputValue('#editor'), /changed/);
    await page.click('#delete-before'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.rows.length === 2);
    assert.deepEqual(await page.evaluate(() => state.rows.map((row) => row.value.id)), [3, 4]);
    assert.equal(await page.evaluate(() => state.rows[0].value.changed), true);
    assert.equal(await page.evaluate(() => state.selected), 0);
    assert.equal(await page.isDisabled('#delete-before'), true);
    await page.click('#undo'); assert.equal(await page.textContent('#count'), '4');
    await page.click('#redo'); assert.equal(await page.textContent('#count'), '2');
    await page.click('#undo');
    await page.fill('#editor', '{broken');
    await page.click('#delete-before'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('JSON 错误'));
    assert.equal(await page.textContent('#count'), '4');
    await page.click('#undo');
    await page.selectOption('#type-filter', '');
    await page.locator('.record-item[title="第 4 行"]').click();
    await page.click('#delete-before'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.rows.length === 1);
    await page.click('#save'); await page.waitForFunction(() => fileWrites === 1);
    assert.equal(await page.evaluate(() => fileContent), '{"id":4,"type":"other"}\r\n');
    await page.evaluate(async () => {
      const text = Array.from({ length: 165 }, (_, i) => JSON.stringify({ id: i + 1 }) + '\n').join('');
      await readFile(new File([text], 'pages.jsonl'));
      state.selected = 80; state.page = 1; render();
    });
    await page.fill('#search', '"id":81');
    await page.click('#delete-before'); await page.click('#dialog-confirm');
    await page.waitForFunction(() => state.rows.length === 85);
    assert.equal(await page.evaluate(() => state.rows[0].value.id), 81);
    assert.equal(await page.evaluate(() => state.rows.at(-1).value.id), 165);
    await page.click('#undo'); assert.equal(await page.textContent('#count'), '165');
    await page.evaluate(async () => {
      const data = [{ type: 'session_meta', payload: { id: 'fixture' } },
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'marker' } },
        { type: 'event_msg', payload: { type: 'marker-two' } }];
      await readFile(new File([data.map((row) => JSON.stringify(row) + '\n').join('')], 'linked.jsonl'), null, { id: 'fixture' });
      state.selected = 1; switchMode('jsonl'); render();
    });
    assert.equal(await page.isDisabled('#delete-before'), true);
    await page.locator('.record-item[title="第 3 行"]').click();
    await page.click('#delete-before');
    assert.match(await page.textContent('#dialog-message'), /session_meta 会保留/);
    await page.click('#dialog-confirm'); await page.waitForFunction(() => state.rows.length === 3);
    assert.equal(await page.evaluate(() => state.rows[0].value.type), 'session_meta');
    assert.equal(await page.evaluate(() => state.rows[1].value.payload.type), 'marker');
    assert.equal(await page.evaluate(() => state.selected), 1);
    await page.click('#source-tab'); assert.equal(await page.isDisabled('#delete-before'), true);
    await page.click('#record-tab');
    await page.screenshot({ path: path.join(__dirname, 'qa', 'delete-before-desktop.png') });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => document.querySelector('#chats-panel').classList.add('collapsed'));
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: prefix deletion, selected-row preservation, filtered/cross-page boundaries, cancel, draft validation, undo/redo, CRLF save, session header protection, mobile.');
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
