import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IvrMap, MapStore } from '../core/memory.js';

/** Persists the shared IVR map to a JSON file. Writes are debounced and atomic. */
export class FileMapStore implements MapStore {
  private timer?: NodeJS.Timeout;
  private latest?: Record<string, IvrMap>;

  constructor(private path: string) {}

  load(): Record<string, IvrMap> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return {};
    }
  }

  save(maps: Record<string, IvrMap>): void {
    this.latest = maps;
    this.timer ??= setTimeout(() => this.flush(), 250);
  }

  flush() {
    this.timer = undefined;
    if (!this.latest) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.latest, null, 1));
    renameSync(tmp, this.path);
  }
}
