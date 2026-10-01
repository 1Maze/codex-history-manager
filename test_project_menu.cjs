const { chromium, browserOptions } = require('./test_support.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
async function run() {
  const browser = await chromium.launch(browserOptions);
  const groups = [
    { key: 'a', name: 'Alpha', threads: Array.from({ length: 8 }, (_, i) => ({ id: `a-${i}`, title: `Shared alpha ${i}` })) },
    { key: 'b', name: 'Beta', threads: [{ id: 'b-0', title: 'Shared beta' }] },
  ];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/sidebar**', async (route) => {
      const url = new URL(route.request().url());
      const project = url.searchParams.get('project'), q = url.searchParams.get('q') || '';
      const selected = groups.filter((group) => !project || group.key === project)
        .map((group) => ({ ...group, threads: group.threads.filter((row) => row.title.includes(q)) }))
        .filter((group) => group.threads.length);
      if (url.pathname.endsWith('/group')) {
        const group = selected.find((item) => item.key === url.searchParams.get('key'));
        const offset = Number(url.searchParams.get('offset')), rows = group.threads.slice(offset, offset + 5);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          rows, total: group.threads.length, nextOffset: offset + rows.length,
        }) });
      } else await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        total: selected.reduce((sum, group) => sum + group.threads.length, 0),
        groups: selected.map((group) => ({ ...group, total: group.threads.length,
          threads: group.threads.slice(0, 5), nextOffset: Math.min(5, group.threads.length) })),
      }) });
    });
    const alpha = page.locator('.project-group[data-project="a"]');
    await page.goto('http://127.0.0.1:5189'); await page.waitForSelector('.project-toggle');
    await alpha.locator('.project-toggle').click({ button: 'right' });
    assert.equal(await page.isVisible('#project-context-menu'), true);
    assert.deepEqual(await page.locator('#project-context-menu button').allTextContents(), ['展开', '折叠', '忽略', '项目内搜索']);
    await page.click('#project-menu-expand');
    assert.equal(await alpha.locator('.chat-item').count(), 5);
    await alpha.locator('.project-toggle').click({ button: 'right' }); await page.click('#project-menu-collapse');
    assert.equal(await alpha.locator('.chat-item').count(), 0);
    await alpha.locator('.project-toggle').focus(); await page.keyboard.press('Shift+F10');
    assert.equal(await page.isVisible('#project-context-menu'), true);
    await page.keyboard.press('Escape'); assert.equal(await page.isVisible('#project-context-menu'), false);
    await alpha.locator('.project-toggle').click({ button: 'right' }); await page.click('#project-menu-search');
    await page.waitForFunction(() => local.searchScope?.key === 'a' && local.groups.length === 1);
    assert.equal(await page.textContent('#project-search-name'), 'Alpha');
    await page.fill('#chat-search', 'Shared');
    await page.waitForFunction(() => local.sidebarQuery === 'Shared');
    assert.equal(await page.locator('.project-group[data-project="b"]').count(), 0);
    assert.equal(await alpha.locator('.chat-item').count(), 5);
    await alpha.locator('.project-more').click();
    await page.waitForFunction(() => document.querySelector('[data-project="a"]').querySelectorAll('.chat-item').length === 8);
    await page.click('#clear-project-scope');
    await page.waitForFunction(() => !local.searchScope && local.groups.length === 2);
    await alpha.locator('.project-toggle').click({ button: 'right' }); await page.click('#project-menu-ignore');
    assert.equal(await page.isVisible('#ignored-workspace'), true);
    assert.equal(await alpha.count(), 0);
    assert.equal(await page.locator('.ignored-project-row').count(), 1);
    assert.match(await page.textContent('.ignored-project-row'), /Alpha/);
    assert.equal(await page.textContent('#ignored-project-count'), '1');
    await page.reload(); await page.waitForSelector('.project-toggle');
    assert.equal(await alpha.count(), 0);
    await page.fill('#chat-search', 'Shared'); await page.waitForFunction(() => local.sidebarQuery === 'Shared');
    assert.equal(await alpha.count(), 0);
    await page.click('#show-ignored-projects'); await page.fill('#ignored-search', 'Alpha');
    assert.equal(await page.locator('.ignored-project-row').count(), 1);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'ignored-projects-desktop.png') });
    await page.getByRole('button', { name: '恢复项目 Alpha', exact: true }).click();
    assert.equal(await page.locator('.ignored-project-row').count(), 0);
    assert.equal(await alpha.count(), 1);
    await page.click('#ignored-back');
    await alpha.locator('.project-menu-trigger').click();
    await page.screenshot({ path: path.join(__dirname, 'qa', 'project-context-menu.png') });
    await page.click('#project-menu-ignore'); await page.click('#restore-all-projects');
    assert.equal(await page.textContent('#ignored-project-count'), '0');
    await page.setViewportSize({ width: 320, height: 844 }); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'ignored-projects-mobile.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: right-click four actions, keyboard menu, project-scoped paging/search, ignore persistence, hidden global results, independent list, restore/all restore, mobile.');
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
