import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const hits = [];
page.on('request', req => {
  const url = req.url();
  if (!/\.(js|css|png|jpg|svg|woff2?|ico|gif)(\?|$)/i.test(url) && /traderjoes/i.test(url)) {
    hits.push(url);
  }
});
await page.goto('https://www.traderjoes.com/home/products', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);

// Look for a "store" or "location" link/button to click
const storeButtons = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('a, button')).filter(el =>
    /store|location|zip/i.test(el.textContent || '') || /store|location/i.test(el.getAttribute('aria-label') || '')
  ).map(el => (el.textContent || el.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 20);
});
console.log('store-related buttons/links found:', storeButtons);
console.log('requests so far:', [...new Set(hits)]);
await browser.close();
