// Export learned phone trees from the server's map store into maps/, the seed
// format for hand-mapped IVRs. Seeds load into the shared map on server boot.
//
//   npm run map:export                 # every tree with at least one screen
//   npm run map:export -- 3155550110   # one number

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IvrMap } from '../src/core/memory.js';

const store = join(process.env.VOICED_DATA ?? '.voiced', 'maps.json');
const maps = JSON.parse(readFileSync(store, 'utf8')) as Record<string, IvrMap>;
const only = process.argv[2]?.replace(/\D/g, '');
mkdirSync('maps', { recursive: true });
for (const [key, map] of Object.entries(maps)) {
  if ((only && key !== only) || !map.screens.length) continue;
  const slug = map.business.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const file = join('maps', `${slug}.json`);
  writeFileSync(file, JSON.stringify({ [key]: { ...map, calls: 0 } }, null, 1) + '\n');
  console.log(`${file}: ${map.screens.length} screens`);
}
