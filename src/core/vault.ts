// The vault keeps secrets (card numbers, PINs, CVVs) out of model context and
// out of transcripts. Brains emit {{fact.key}} placeholders; the vault resolves
// them at the last moment, right before the tones go down the line.

import type { Fact } from './types.js';

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export class Vault {
  private secrets = new Map<string, string>();
  private facts = new Map<string, Fact>();

  constructor(facts: Fact[], secrets: Record<string, string> = {}) {
    for (const f of facts) this.facts.set(f.key, f);
    for (const [k, v] of Object.entries(secrets)) this.secrets.set(k, v);
  }

  set(key: string, value: string) {
    this.secrets.set(key, value);
  }

  /** Remove ephemeral secrets (e.g. CVV) once the call ends. */
  wipe(keys: string[]) {
    for (const k of keys) this.secrets.delete(k);
  }

  isSecret(key: string): boolean {
    return this.facts.get(key)?.secret === true || this.secrets.has(key);
  }

  /** Placeholders referenced by a template. */
  refs(template: string): string[] {
    return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
  }

  /** Resolve placeholders to real values. Throws on unknown keys or disallowed secrets. */
  resolve(template: string, opts: { allowSecrets: boolean }): string {
    return template.replace(PLACEHOLDER, (_, key: string) => {
      if (this.secrets.has(key)) {
        if (!opts.allowSecrets) throw new VaultError(`secret {{${key}}} cannot be used here`);
        return this.secrets.get(key)!;
      }
      const fact = this.facts.get(key);
      if (fact?.value !== undefined) return fact.value;
      throw new VaultError(`unknown placeholder {{${key}}}`);
    });
  }

  /** Human-safe rendering of a template: secrets become their redacted display. */
  redact(template: string): string {
    return template.replace(PLACEHOLDER, (_, key: string) => {
      const fact = this.facts.get(key);
      if (this.secrets.has(key) || fact?.secret) return fact?.display ?? '••••';
      return fact?.value ?? `{{${key}}}`;
    });
  }

  /** Mask any secret value that shows up verbatim in heard text (e.g. an IVR reading digits back). */
  scrub(text: string): string {
    let out = text;
    for (const [key, value] of this.secrets) {
      if (value.length < 3) continue;
      const pattern = value
        .split('')
        .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s-]?');
      out = out.replace(new RegExp(pattern, 'g'), this.facts.get(key)?.display ?? '••••');
    }
    return out;
  }
}

export class VaultError extends Error {}
