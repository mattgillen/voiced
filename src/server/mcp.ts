// Voiced as MCP tools. The same tool set is served over streamable HTTP (remote
// connectors: Muse, Claude, ChatGPT-style agents) and over stdio (local agents
// such as OpenClaw).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CallManager } from './calls.js';

const INSTRUCTIONS = `Voiced is the phone layer for AI agents. It calls businesses for the user and handles the phone tree: IVR menus, account lookups, bill payments, reservations, cancellations, hold queues. When a live human is needed it briefs them and hands the call to the user. It is AI with human backup: if the AI gets stuck, a Voiced operator steps in, and the call reports resolution "ai", "human_assisted" or "failed". Tell the user honestly which it was.

Typical flow:
1. list_businesses to find the business_id (this demo build has simulated phone trees only).
2. start_call with the business_id and any limits the user gave you (max_amount for payments).
3. get_call with wait_seconds to follow along. If pending_request is set, show the user its title and detail and the approval_url, or ask them directly and relay their answer with respond_to_call. Never approve on the user's behalf. For kind "input" (e.g. an identity check), send the user to approval_url so the answer goes straight to the vault instead of through this chat.
4. When status is "ended", tell the user the summary. Share watch_url if they want to see the live transcript.`;

export function buildMcpServer(calls: CallManager, owner: string): McpServer {
  const server = new McpServer({ name: 'voiced', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
  const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });
  const find = (id: string) => {
    const call = calls.get(id);
    return call && call.owner === owner ? call : undefined;
  };

  server.registerTool(
    'list_businesses',
    {
      title: 'List businesses',
      description: 'Businesses Voiced can call, with how well each phone tree is mapped and its completion rate.',
      annotations: { readOnlyHint: true },
    },
    async () => json(calls.directory()),
  );

  server.registerTool(
    'start_call',
    {
      title: 'Start a call',
      description:
        'Place a phone call that Voiced handles end to end: it navigates the IVR, enters account details from the secure vault (the model never sees card numbers or PINs), waits on hold, and hands a live human to the user. Returns right away with a call id; follow it with get_call. Payments above max_amount, unapproved fees and other judgment calls come back as a pending_request for the user.',
      inputSchema: {
        business_id: z.string().describe('From list_businesses, e.g. "bedford".'),
        instructions: z.string().optional().describe("Anything extra the user asked for, in their words."),
        max_amount: z.number().positive().optional().describe('Pre-approved payment cap in dollars, before fees.'),
        max_fee: z.number().min(0).optional().describe('Pre-approved fees in dollars. Default 0: any fee needs the user.'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const call = calls.start({ business_id: args.business_id, instructions: args.instructions, max_amount: args.max_amount, max_fee: args.max_fee }, owner);
        return json(calls.view(call));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_call',
    {
      title: 'Get call status',
      description:
        'Status, pending request, transcript tail and result of a call. With wait_seconds, blocks until something needs attention (a pending approval, a handoff, or the end of the call) or the time runs out.',
      inputSchema: {
        call_id: z.string(),
        wait_seconds: z.number().min(0).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ call_id, wait_seconds }) => {
      const call = find(call_id);
      if (!call) return fail(`No call ${call_id}`);
      if (wait_seconds) await calls.waitForChange(call, wait_seconds * 1000);
      return json(calls.view(call));
    },
  );

  server.registerTool(
    'respond_to_call',
    {
      title: 'Relay the user’s decision',
      description:
        "Answer a call's pending_request with the user's explicit decision. Only call this after the user has said yes or no (or picked an option). Never approve on your own.",
      inputSchema: {
        call_id: z.string(),
        request_id: z.string(),
        approved: z.boolean(),
        choice: z.string().optional().describe('For kind=choose: the option the user picked.'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ call_id, request_id, approved, choice }) => {
      const call = find(call_id);
      if (!call) return fail(`No call ${call_id}`);
      if (!call.session.respond(request_id, { approved, choice })) return fail(`Request ${request_id} is not pending`);
      await new Promise((r) => setTimeout(r, 50));
      return json(calls.view(call));
    },
  );

  server.registerTool(
    'hang_up',
    {
      title: 'Hang up',
      description: 'End a call now.',
      inputSchema: { call_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ call_id }) => {
      const call = find(call_id);
      if (!call) return fail(`No call ${call_id}`);
      await call.session.hangup();
      return json(calls.view(call));
    },
  );

  server.registerTool(
    'get_stats',
    {
      title: 'Completion stats',
      description: 'Call completion rate and IVR map coverage across all calls on this server.',
      annotations: { readOnlyHint: true },
    },
    async () => json(calls.stats()),
  );

  return server;
}
