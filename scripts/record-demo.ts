// Records the launch demo video from the built page:
//   npm run build:web && npx tsx scripts/record-demo.ts   →  demo/voiced-demo.mp4 (+ .webm)

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { routeFonts } from './browser.js';

const size = { width: 1280, height: 800 };
const tmp = resolve('.voiced/video');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: size, colorScheme: 'light', recordVideo: { dir: tmp, size } });
await routeFonts(context);
const page = await context.newPage();
await page.goto(`file://${resolve('demo/voiced.html')}`);

// Captions and a visible cursor for the video (not part of the product).
await page.addStyleTag({
  content: `
  .app{padding-bottom:78px}
  .foot{display:none}
  #cap{pointer-events:none;position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99;max-width:min(900px,90vw);
    background:#14201a;color:#fff;font:600 21px/1.35 'Public Sans',system-ui,sans-serif;padding:12px 20px;border-radius:12px;
    box-shadow:0 10px 30px rgb(0 0 0/.25);text-align:center;transition:opacity .25s}
  #cap:empty{opacity:0}
  #cur{position:fixed;z-index:100;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgb(15 122 91/.35);
    border:2px solid #0f7a5b;pointer-events:none;transition:transform .12s}
  #cur.down{transform:scale(.7)}`,
});
await page.evaluate(() => {
  const cap = Object.assign(document.createElement('div'), { id: 'cap' });
  const cur = Object.assign(document.createElement('div'), { id: 'cur' });
  document.body.append(cap, cur);
  addEventListener('mousemove', (e) => Object.assign(cur.style, { left: `${e.clientX}px`, top: `${e.clientY}px` }));
  addEventListener('mousedown', () => cur.classList.add('down'));
  addEventListener('mouseup', () => cur.classList.remove('down'));
});

const caption = (text: string) => page.evaluate((t) => (document.getElementById('cap')!.textContent = t), text);
const wait = (ms: number) => page.waitForTimeout(ms);
async function click(p: Page, selector: string) {
  const box = await p.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no ${selector}`);
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await wait(250);
  await p.mouse.down();
  await wait(90);
  await p.mouse.up();
}

await page.mouse.move(640, 420);
await caption('AI assistants can’t get through a phone tree. Voiced can.');
await wait(3200);
await caption('Say “pay my Bedford utilities bill”. Approve the card and a limit, once.');
await click(page, '#hero-cta');
await wait(1800);
await click(page, '#sheet-form button[type=submit]');
await caption('Voiced dials and gets through the menus, keying your account and card from the vault.');
await wait(7000);
await caption('The model never sees the card number. It types {{card.number}} and the vault fills it in.');
await page.waitForSelector('#push:not([hidden])', { timeout: 60_000 });
await caption('A $2.95 fee you didn’t approve? It stops and asks. That’s the only interruption.');
await wait(2600);
await click(page, '#push .primary');
await page.waitForSelector('#result:not([hidden])', { timeout: 60_000 });
const firstTime = await page.textContent('#result .stat b');
await caption(`Paid. Confirmation 4820177. ${firstTime} on the phone for you, 1 tap from you.`);
await wait(3800);
await caption('Every call maps the phone tree. The next caller skips the listening.');
await click(page, '#result .primary');
await page.waitForSelector('#push:not([hidden])', { timeout: 60_000 });
await wait(900);
await click(page, '#push .primary');
await page.waitForSelector('#result:not([hidden])', { timeout: 60_000 });
const secondTime = await page.textContent('#result .stat b');
const replayed = await page.textContent('#result .stat.win b');
await caption(`Second call: ${firstTime} → ${secondTime}. ${replayed} screens replayed from the map, zero model calls.`);
await wait(4200);

await caption('Cancellations: no “cancel” in the menu, two retention offers. Declined.');
await click(page, '#result .secondary');
await wait(700);
await click(page, '.task:has-text("Cancel my gym")');
await wait(1300);
await click(page, '#sheet-form button[type=submit]');
await page.waitForSelector('#result:not([hidden])', { timeout: 60_000 });
await caption('Canceled. Confirmation CX44190. You tapped once.');
await wait(3200);

await caption('Need a person? Voiced gets past the deflection and waits out the hold for you.');
await click(page, '#result .secondary');
await wait(600);
await click(page, '#speed-seg [data-speed="20"]');
await click(page, '.task:has-text("hand me a human")');
await wait(1200);
await click(page, '#sheet-form button[type=submit]');
await page.waitForSelector('.hold-row', { timeout: 60_000 });
await caption('18 minutes of hold music. You don’t hear any of it.');
await page.waitForSelector('#talk:not([hidden])', { timeout: 90_000 });
await caption('A person picks up. Voiced says it’s an AI, briefs her, and hands the call to you.');
await wait(3400);
await click(page, '#replies button');
await wait(4200);
await click(page, '#replies button');
await page.waitForSelector('#result:not([hidden])', { timeout: 60_000 });
await wait(1500);
await caption('Voiced: the phone layer for AI agents. API · MCP · built for Muse connectors.');
await wait(4000);

await context.close();
await browser.close();

const webm = readdirSync(tmp).find((f) => f.endsWith('.webm'))!;
mkdirSync('demo', { recursive: true });
copyFileSync(join(tmp, webm), 'demo/voiced-demo.webm');
const ffmpeg = execFileSync('python3', ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', 'demo/voiced-demo.webm', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'medium', '-movflags', '+faststart', 'demo/voiced-demo.mp4']);
console.log('wrote demo/voiced-demo.mp4 and demo/voiced-demo.webm');
