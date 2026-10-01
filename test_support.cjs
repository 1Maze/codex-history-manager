const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browserOptions = { headless: true };
if (process.env.PLAYWRIGHT_BROWSER_CHANNEL) browserOptions.channel = process.env.PLAYWRIGHT_BROWSER_CHANNEL;
module.exports = { chromium, browserOptions };
