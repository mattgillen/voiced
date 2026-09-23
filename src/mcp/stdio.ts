// Voiced as a local MCP server over stdio, for agents that run on your machine
// (OpenClaw, Claude Desktop, Claude Code). Runs the call engine in-process.
//
//   { "mcpServers": { "voiced": { "command": "npx", "args": ["tsx", "src/mcp/stdio.ts"], "cwd": "/path/to/voiced" } } }

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeBrain } from '../brains/claude.js';
import { RulesBrain } from '../brains/rules.js';
import { MapMemory } from '../core/memory.js';
import { CallManager } from '../server/calls.js';
import { buildMcpServer } from '../server/mcp.js';
import { FileMapStore } from '../server/store.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DATA = process.env.VOICED_DATA ?? join(ROOT, '.voiced');
const useClaude = process.env.VOICED_BRAIN === 'claude' || (!!process.env.ANTHROPIC_API_KEY && process.env.VOICED_BRAIN !== 'rules');

const calls = new CallManager({
  memory: new MapMemory(new FileMapStore(join(DATA, 'maps.json'))),
  brain: () => (useClaude ? new ClaudeBrain() : new RulesBrain()),
  baseUrl: process.env.PUBLIC_URL ?? 'http://localhost:8787',
  logPath: join(DATA, 'calls.jsonl'),
  apiSpeed: Number(process.env.VOICED_SPEED ?? 40),
});

const server = buildMcpServer(calls, 'local');
await server.connect(new StdioServerTransport());
