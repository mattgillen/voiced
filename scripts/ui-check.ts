// Drives the built demo page in Chromium: runs the Bedford bill pay end to end
// (approving the fee), runs it again to show the map speedup, and screenshots.
//   npx tsx scripts/ui-check.ts [outdir]

import { chromium } from 'playwright';
import { routeFonts } from './browser.js';
import { resolve } from 'node:path';

const out = process.argv[2] ?? 'shots';
const file = `file://${resolve('demo/voiced.html')}`;
const browser = await chromium.launch();
const errors: string[] = [];

for (const [name, viewport, scheme] of [
  ['desktop', { width: 1440, height: 900 }, 'light'],
  ['phone', { width: 390, height: 844 }, 'dark'],
] as const) {
  const context = await browser.newContext({ viewport, colorScheme: scheme });
  await routeFonts(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`));
  await page.goto(file);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}-1-idle.png`, fullPage: name === 'phone' });

  await page.click('#hero-cta');
  await page.screenshot({ path: `${out}/${name}-2-authorize.png` });
  await page.click('#sheet-form button[type=submit]');
  await page.click('#speed-seg [data-speed="20"]');
  await page.waitForSelector('#push:not([hidden])', { timeout: 30_000 });
  await page.screenshot({ path: `${out}/${name}-3-fee-approval.png`, fullPage: name === 'phone' });
  await page.click('#push .primary');
  await page.waitForSelector('#result:not([hidden])', { timeout: 30_000 });
  await page.screenshot({ path: `${out}/${name}-4-paid.png`, fullPage: name === 'phone' });
  const summary = await page.textContent('#result p');
  console.log(`${name}: ${summary}`);

  if (name === 'desktop') {
    await page.click('#result .primary');
    await page.waitForSelector('#push:not([hidden])', { timeout: 30_000 });
    await page.click('#push .primary');
    await page.waitForSelector('#result:not([hidden])', { timeout: 30_000 });
    console.log(`desktop run 2: ${await page.textContent('#result .compare')}`);
    await page.screenshot({ path: `${out}/${name}-5-map-replay.png` });

    // Reach a human: hold, pickup, handoff, talk.
    await page.click('#result .secondary');
    await page.click('.task:has-text("hand me a human")');
    await page.click('#sheet-form button[type=submit]');
    await page.waitForSelector('#talk:not([hidden])', { timeout: 60_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/${name}-6-handoff.png` });
    await page.click('#replies button');
    await page.waitForTimeout(2500);
    await page.click('#replies button');
    await page.waitForSelector('#result:not([hidden])', { timeout: 30_000 });
    await page.screenshot({ path: `${out}/${name}-7-human-done.png` });
    console.log(`desktop kestrel: ${await page.textContent('#result p')}`);
  }
  await context.close();
}
await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
