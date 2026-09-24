// Shared Playwright setup for UI checks and the demo recording.
import { execFileSync } from 'node:child_process';
import type { BrowserContext } from 'playwright';

/**
 * Serve Google Fonts through curl. The sandbox's egress proxy re-signs TLS with
 * a CA that curl trusts but Playwright's bundled Chromium does not.
 */
export async function routeFonts(context: BrowserContext) {
  await context.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    try {
      const url = route.request().url();
      const body = execFileSync('curl', ['-sS', '--fail', '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141 Safari/537.36', url], { maxBuffer: 20e6 });
      const type = url.includes('googleapis') ? 'text/css' : 'font/woff2';
      await route.fulfill({ body, headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
    } catch {
      await route.abort();
    }
  });
}
