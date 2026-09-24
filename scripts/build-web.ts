// Builds the web app two ways:
//   web/dist/        index.html + app.js + styles.css, served by the Voiced server
//   demo/voiced.html one self-contained page (runs the whole engine in the browser)

import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'web', 'dist');
mkdirSync(out, { recursive: true });
mkdirSync(join(root, 'demo'), { recursive: true });

const result = await build({
  entryPoints: [join(root, 'web', 'app.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2021',
  minify: true,
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
const js = result.outputFiles[0].text;
const css = readFileSync(join(root, 'web', 'styles.css'), 'utf8');
const page = readFileSync(join(root, 'web', 'app.html'), 'utf8');
const [head, bodyWithScript] = page.split('<!--STYLES-->');

writeFileSync(join(out, 'app.js'), js);
writeFileSync(join(out, 'styles.css'), css);
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head.trim()}
<link rel="stylesheet" href="/styles.css">
<!--VOICED_CONFIG-->
</head>
<body>
${bodyWithScript.replace('<!--SCRIPT-->', '<script src="/app.js"></script>').trim()}
</body>
</html>
`,
);

const inlineJs = js.replace(/<\/script/gi, '<\\/script');
writeFileSync(
  join(root, 'demo', 'voiced.html'),
  `${head.trim()}\n<style>\n${css}</style>\n${bodyWithScript.replace('<!--SCRIPT-->', () => `<script>\n${inlineJs}</script>`).trim()}\n`,
);
console.log(`web/dist: app.js ${(js.length / 1024).toFixed(0)} KB · demo/voiced.html ${((js.length + css.length) / 1024).toFixed(0)} KB`);
