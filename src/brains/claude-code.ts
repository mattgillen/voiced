// The Claude Code brain: each decision runs Claude Code in print mode (`claude -p`), so calls run on
// the Claude login of whoever runs Voiced (a Claude subscription works; no API key). Same prompt and
// validation as the other model brains, in the JSON-output form. Tools, MCP servers, settings and
// session files are off, and so is thinking, so a turn is a process start plus one short completion
// (about 2.5 s). A turn over the time budget throws, and rules take it.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { Decision } from '../core/types.js';
import type { Brain, BrainState } from './brain.js';
import { JSON_INSTRUCTIONS, renderContext, SYSTEM_PROMPT, toDecision } from './prompt.js';

export const CLAUDE_CODE_DEFAULT_MODEL = 'sonnet';

export type RunCli = (bin: string, args: string[], input: string, timeoutMs: number) => Promise<string>;

export interface ClaudeCodeBrainOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  /** Runs the CLI with the prompt on stdin and returns stdout. Tests stub it. */
  run?: RunCli;
}

export class ClaudeCodeBrain implements Brain {
  readonly name = 'claude-code';
  readonly model: string;
  private bin: string;
  private timeoutMs: number;
  private run: RunCli;
  private warned = new Set<string>();

  constructor(opts: ClaudeCodeBrainOptions = {}) {
    this.bin = opts.bin ?? process.env.VOICED_CLAUDE_BIN ?? 'claude';
    this.model = opts.model ?? process.env.VOICED_CLAUDE_CODE_MODEL ?? CLAUDE_CODE_DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.VOICED_CLAUDE_CODE_TIMEOUT_MS ?? 10_000);
    this.run = opts.run ?? runCli;
  }

  async decide(s: BrainState): Promise<Decision> {
    try {
      return await this.attempt(s);
    } catch (err) {
      // The session falls back to rules; say why once, so a missing CLI or login isn't silent.
      const msg = (err as Error).message;
      if (!this.warned.has(msg)) {
        this.warned.add(msg);
        console.warn(`[claude-code] ${msg} (rules took this turn)`);
      }
      throw err;
    }
  }

  private async attempt(s: BrainState): Promise<Decision> {
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', this.model,
      '--effort', 'low',
      '--system-prompt', SYSTEM_PROMPT,
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--no-session-persistence',
      '--disable-slash-commands',
    ];
    const out = await this.run(this.bin, args, `${renderContext(s)}\n\n${JSON_INSTRUCTIONS}`, this.timeoutMs);
    let envelope: { is_error?: boolean; result?: unknown; subtype?: string };
    try {
      envelope = JSON.parse(out);
    } catch {
      throw new Error(`claude -p printed something other than JSON: ${out.trim().slice(0, 120)}`);
    }
    if (envelope.is_error) throw new Error(`claude -p failed: ${String(envelope.result ?? envelope.subtype).slice(0, 160)}`);
    // The action may come wrapped in a code fence; take the outermost object.
    const json = String(envelope.result ?? '').match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('Claude answered without a JSON action');
    const { tool, ...input } = JSON.parse(json) as { tool?: unknown } & Record<string, unknown>;
    return toDecision(String(tool), input, s);
  }
}

/** Runs outside the repo (no CLAUDE.md or .mcp.json), with thinking off for latency. */
const runCli: RunCli = (bin, args, input, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: tmpdir(), env: { ...process.env, MAX_THINKING_TOKENS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p took over ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `${bin} not found: install Claude Code and run "claude" once to log in` : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${(err || out).trim().slice(0, 200)}`));
    });
    child.stdin.end(input);
  });
