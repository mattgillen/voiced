---
name: voiced-phone-calls
description: Make phone calls to businesses for the user with Voiced. It gets through phone trees, pays bills within an approved limit, cancels memberships, waits on hold, and hands a live human to the user. Use when a task can only be done by calling a company.
---

# Voiced phone calls

Voiced places the call and handles the phone tree. You start the call, follow it, and relay the user's decisions. You never see card numbers or PINs; Voiced keeps them in its vault.

## Setup

Either connect Voiced's MCP server (tools: `list_businesses`, `start_call`, `get_call`, `respond_to_call`, `hang_up`, `get_stats`):

```json
{ "mcpServers": { "voiced": { "command": "npx", "args": ["tsx", "/path/to/voiced/src/mcp/stdio.ts"] } } }
```

or call the REST API with `VOICED_URL` (e.g. `http://localhost:8787`) and `VOICED_API_KEY` set:

```bash
H="Authorization: Bearer $VOICED_API_KEY"
curl -s "$VOICED_URL/v1/businesses" -H "$H"
```

## Workflow

1. **Find the business.** `list_businesses` (or `GET /v1/businesses`). Use its `id` as `business_id`.
2. **Confirm limits before money moves.** For bill payments, ask the user for a cap if they didn't give one, and pass it as `max_amount`. Don't pre-approve fees unless the user said so (`max_fee`).
3. **Start the call.** `start_call` / `POST /v1/calls` with `{"business_id": "...", "max_amount": 200}`. Tell the user you're calling and share `watch_url` if they want the live transcript.
4. **Follow it.** `get_call` with `wait_seconds: 30` (REST: `GET /v1/calls/<id>?wait=30`) until `status` is `ended`, or until `pending_request` appears.
5. **Relay decisions, never make them.** When `pending_request` is set, show the user its `title` and `detail` (and the total for payments). Either send them the `approval_url` or ask them directly, then call `respond_to_call` with their answer. Never approve on your own.
6. **Handoff.** If `status` becomes `user_connected`, a person from the business is on the line with the user; stop polling for decisions and let them talk.
7. **Report.** When the call ends, tell the user the `summary` and any confirmation number in `notes`.

## Rules

- Only call businesses the user asked you to call.
- Payments need a user-approved cap. Anything above it comes back as a `pending_request`.
- Voiced tells every person on a call that it is an AI assistant. Don't ask it to pretend otherwise.
