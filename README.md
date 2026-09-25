# Voiced

**The phone layer for AI agents.** Your agent says "pay my Bedford utilities bill." Voiced makes the call: it gets through the phone tree, keys the account and card from a vault the model never sees, pays within the limits the user approved, waits on hold, and hands the user a briefed human when one is needed.

- **For agent platforms and developers:** REST + OpenAPI, remote MCP with OAuth, local MCP over stdio. Built to plug into Muse's connector platform and anything else that speaks MCP.
- **AI-first, with a human fallback:** when the AI gets stuck (a dead end, a loop, an identity check), the call goes to a Voiced operator with full context instead of failing. What the operator does gets learned, so the next call doesn't need them.
- **The moat:** a shared map of phone trees. Every call teaches Voiced the tree, so the next call to that number (from any user, on any agent) replays the known screens instead of listening to them.
- **Top-line metric:** share of calls resolved by AI with no human (`GET /v1/stats`, `npm run eval`). Every call ends as `ai`, `human_assisted` or `failed`, with the reason, the step where it broke, and the billable result.

Strategy, market and risks are in [docs/PITCH.md](docs/PITCH.md); the human-fallback design is in [docs/DESIGN.md](docs/DESIGN.md). The demo video is [demo/voiced-demo.mp4](demo/voiced-demo.mp4).

> **What's real in this build.** The call engine, map, vault, policy guard, operator queue, API, MCP and OAuth all run end to end. The businesses are **simulated phone trees** (fictional companies, 555-01xx numbers, public test cards), and the operator in the demo and evals is a **scripted stand-in**; the operator API is there for real people. The Twilio line for real calls is written and protocol-tested but has **not yet been run against a live Twilio account**. The model brains (Gemini and Claude) are wired and unit-tested with stubbed clients; run them live with `GEMINI_API_KEY` (free tier works) or `ANTHROPIC_API_KEY`.

## Quick start

```bash
npm install
npm test                    # 43 tests: engine, map, vault, guard, outcomes, operators, dial policy, server, OAuth + MCP, Twilio protocol, brains
npm run sim bedford         # watch one call in the terminal
npm run sim all -- --twice  # every tree, twice: the second run replays the map
npm run sim hard            # the hard cases: loop → operator, identity check, closures
npm run eval                # score every tree's outcome (AI / human-assisted / failed) against the expected one
npm run build:web && npm start   # web app + API + MCP on http://localhost:8787
```

Everything above runs on the rules brain with no keys. To put a model in the loop:

```bash
cp .env.example .env        # then fill in GEMINI_API_KEY (free: https://aistudio.google.com/apikey)
npm run sim bedford -- --gemini
npm run eval -- --gemini    # also prints how many model turns failed and fell back to rules
npm start                   # the server picks Gemini up from .env
```

In a Claude Code cloud session there's no `.env`: add the variables in the environment's settings and start a new session. Keys never go in chat, commits or the web app.

Gemini's free tier is fine for the simulator and your own calls. Google may use free-tier prompts to improve its products, and while secrets never reach the model, names, ZIPs and transcripts do, so use a paid key for anyone else's calls.

Open `demo/voiced.html` directly in a browser for the standalone demo, which runs the whole engine in the page.

## What a call looks like

```
    16s  IVR   For English, press 1.
    16s  AGENT [press] 1                    ← map: Pressing 1: "English"
    20s  IVR   To report a power outage or emergency, press 1.
    20s  AGENT [press] 2                    ← map: Pressing 2: "billing and payments"
    ...
 1m 14s  IVR   Please enter your credit or debit card number, followed by the pound key.
 1m 14s  AGENT [press] Visa •• 4242#        ← map: Entering card number from the vault
    ...
 1m 56s  ⚠︎ ASK Bedford Falls Electric & Water adds a $2.95 fee: Balance $142.17 + $2.95 card fee = $145.12…
 1m 56s  AGENT [press] 1                    ← rules: You approved $145.12. Authorizing.
 2m 09s  IVR   Your confirmation number is 4 8 2 0 1 7 7.
→ SUCCESS: Paid $145.12 to Bedford Falls Electric & Water with Visa •• 4242. Confirmation 4820177.
  call 2m 09s · you tapped 1× · map hits 9 · model calls 0
```

## Connect an agent

Run the server somewhere with public HTTPS (connectors can't reach `localhost`). For a quick tunnel: `cloudflared tunnel --url http://localhost:8787`, then start with `PUBLIC_URL=https://<your-tunnel> npm start`.

| Surface | Endpoint | Auth |
|---|---|---|
| Remote MCP (streamable HTTP) | `POST {PUBLIC_URL}/mcp` | OAuth 2.1 (dynamic client registration + PKCE), or `Authorization: Bearer <VOICED_API_KEY>` |
| OpenAPI spec | `GET {PUBLIC_URL}/openapi.json` | none (describes bearer + OAuth) |
| REST | `{PUBLIC_URL}/v1/...` | Bearer API key or OAuth token |
| Local MCP (stdio) | `npx tsx src/mcp/stdio.ts` | none (runs in-process) |

- **Muse:** see [integrations/muse](integrations/muse/README.md) for custom-connector setup and the directory submission kit.
- **Claude / Claude Code:** add a custom connector with the MCP URL (OAuth), or in `.mcp.json`:
  ```json
  { "mcpServers": { "voiced": { "type": "http", "url": "https://<host>/mcp", "headers": { "Authorization": "Bearer vk_..." } } } }
  ```
- **Local agents (OpenClaw, Claude Desktop):** stdio, `{ "command": "npx", "args": ["tsx", "/path/to/voiced/src/mcp/stdio.ts"] }`, or the [OpenClaw skill](integrations/openclaw/SKILL.md).

MCP tools: `list_businesses`, `start_call`, `get_call` (long-polls with `wait_seconds`), `respond_to_call`, `hang_up`, `get_stats`.

### REST in four requests

```bash
H='Authorization: Bearer vk_demo_local'
curl -s localhost:8787/v1/businesses -H "$H"
curl -s localhost:8787/v1/calls -H "$H" -H 'content-type: application/json' \
  -d '{"business_id":"bedford","max_amount":200}'
curl -s "localhost:8787/v1/calls/<id>?wait=30" -H "$H"          # returns when it needs you
curl -s localhost:8787/v1/calls/<id>/respond -H "$H" -H 'content-type: application/json' \
  -d '{"request_id":"<pending_request.id>","approved":true}'
```

Every call returns a `watch_url` (live transcript) and, when approval is needed, an `approval_url`. Both are capability links scoped to that one call, so an agent can hand them to the user without sharing its credentials.

## How it works

```mermaid
flowchart LR
  A[Agent: Muse / Claude / OpenClaw] -- MCP / REST --> S[CallSession]
  S -- listen / press / say / bridge --> L{{Line}}
  L --> Sim[Simulated phone trees]
  L --> Tw[Twilio ConversationRelay]
  S -- known screen? --> M[(Shared IVR map)]
  S -- prompt ended --> B[Brain: Claude or rules]
  B --> G[Policy guard]
  G --> V[Vault resolves {{card.number}}]
  S -- money / judgment --> U[User approval]
  S -- human answers --> H[Brief rep, hand off to user]
```

- **CallSession** ([src/core/session.ts](src/core/session.ts)) listens sentence by sentence. A screen the map knows is replayed the moment the IVR starts accepting input (barge-in). Otherwise the brain decides when the prompt ends.
- **IVR map** ([src/core/memory.ts](src/core/memory.ts)): screens are keyed by prompt fingerprints (amounts, dates and digits masked), and each stores the action that worked per task type, plus the next screen. A replay that leads to "invalid option" or loops back gets distrusted and relearned. It learns only from automated prompts; human speech is never stored.
- **Vault** ([src/core/vault.ts](src/core/vault.ts)): the brain writes `{{card.number}}`, `{{account}}`, `{{pin}}`, and digits are filled in right before the tones are sent. Heard text is scrubbed, the CVV is wiped at hangup, and secrets are never spoken to a person.
- **Policy guard**: payments above the pre-approval, unapproved fees and unauthorized irreversible steps become user approvals, whatever the model says. This is enforced in code, and a test uses a reckless brain to prove it.
- **Brains** ([src/brains](src/brains)): the Claude brain makes one Messages API call per decision point, with a cached system prompt, six tools, `claude-opus-5` at low effort, and server-side refusal fallbacks. The rules brain is deterministic and handles menus, keypad entry, speech slots, verification, commit steps, retention offers, hold and humans. It's the fallback when the model fails, and the baseline the model has to beat.
- **Handoff**: disclose AI, state the purpose, ask to connect, bridge the user in. On Twilio: ring the user, "press 1 to connect", then move the business leg into a conference.

## Outcomes, operators and evals

Every call ends with:

```json
{ "resolution": "human_assisted",
  "result": { "kind": "membership_canceled", "confirmation": "CX44190",
              "evidence": { "t": 229000, "text": "Your cancellation confirmation number is C X 4 4 1 9 0." } },
  "failure": { "reason": "loop", "step": "Menu: update your payment method · freeze your membership · …",
               "detail": "The phone tree keeps sending the call back to …" } }
```

- `resolution`: `ai` (no human), `human_assisted` (an operator acted), or `failed`. Users approving fees or answering identity checks is authorization, not help.
- `result`: the billable outcome (pricing is per result), with the line on the call that proves it.
- `failure`: why and where it broke, kept even when an operator rescued the call, so every exception becomes a test case.

**Operator queue** (the stub a human console sits on; operators see redacted context and act with placeholders, never secrets):

```bash
O='Authorization: Bearer vo_demo_local'                  # VOICED_OPERATOR_KEY
curl -s localhost:8787/v1/operator/tickets?status=waiting -H "$O"
curl -s localhost:8787/v1/operator/tickets/<id>/actions -H "$O" -H 'content-type: application/json' \
  -d '{"type":"say","text":"Cancel my membership.","operator":"sam"}'   # press | say | handoff | return | hangup
```

By default the server runs a scripted stand-in operator for the simulated trees (`VOICED_OPERATOR=manual` turns it off).

**Eval:** `npm run eval` replays the demo trees and the hard cases, cold and warm, and checks each outcome. Rules brain today: 18/18 match, 72% resolved by AI, 6% with human help, 22% failed (all closures nobody could finish by phone). See [docs/DESIGN.md](docs/DESIGN.md).

## Compliance guardrails

- **Vault:** card, bank, account, PIN and SSN values never reach the model, transcripts, logs, operator tickets or API responses. Recording pauses during vault entry, and CVVs are wiped at hangup.
- **Disclosure:** the agent says it's an automated assistant calling on the customer's behalf. Operators are disclosed too ("AI with human backup").
- **Recording consent:** off unless `VOICED_RECORD=1`. When on, every call is treated as all-party consent. The map learns only from automated prompts, never from people.
- **TCPA line:** real calls go only to allowlisted business lines (`VOICED_ALLOWED_NUMBERS`) or ones attested as business lines (`custom.business_line_attested`), never to the user's own number.

## Configuration

| Env | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `PUBLIC_URL` | `http://localhost:PORT` | public https base; required for connectors and Twilio |
| `VOICED_API_KEY` | `vk_demo_local` | developer key; change it anywhere public |
| `GEMINI_API_KEY` | unset | enables the Gemini brain (`GOOGLE_API_KEY` also works) |
| `VOICED_GEMINI_MODEL` / `VOICED_GEMINI_THINKING` | `gemini-flash-latest` / model default | thinking: `low`/`high`, or a token budget |
| `ANTHROPIC_API_KEY` | unset | enables the Claude brain; wins over Gemini when both are set |
| `VOICED_MODEL` / `VOICED_EFFORT` | `claude-opus-5` / `low` | |
| `VOICED_BRAIN` | first key present, else `rules` | force `rules`, `gemini` or `claude` |
| `VOICED_DATA` | `.voiced/` | map store and call log |
| `VOICED_OPERATOR` / `VOICED_OPERATOR_KEY` | scripted / `vo_demo_local` | operator mode and operator API key |
| `VOICED_ALLOWED_NUMBERS` | unset | comma-separated business lines real calls may dial |
| `VOICED_RECORD` | unset | `1` records real calls (paused during vault entry) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER`, `VOICED_USER_PHONE` | unset | enables real calls (`custom` tasks on `POST /v1/calls`) |
| `TWILIO_API_KEY`, `TWILIO_API_SECRET` | unset | for Twilio's own MCP server (below), not for calls |

All of these can go in `.env` (see `.env.example`).

### Twilio's MCP server (for setup, not for calls)

`.mcp.json` registers Twilio's official MCP server ([`@twilio-alpha/mcp`](https://www.npmjs.com/package/@twilio-alpha/mcp), pinned) so Claude Code can buy and configure numbers, and read call logs, notifications and recordings while debugging real calls. It's filtered to 20 tools (calls, recordings, notifications, phone numbers) because the full API is 197 tools and about 300 KB of schemas. It needs `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY` and `TWILIO_API_SECRET`, plus network access to `api.twilio.com`. It doesn't navigate phone trees: it can start a call, but nothing in it listens, decides or keys digits. That's Voiced.

### Making real calls (Twilio)

1. In the Twilio Console, enable the *Predictive and Generative AI/ML Features Addendum* (ConversationRelay won't run without it).
2. Set the Twilio env vars and `PUBLIC_URL` (https; Twilio connects to `wss://<host>/twilio/relay`).
3. Start a call with a custom task. Standard fact keys (`zip`, `account`, `card.number`, `card.exp`, `card.cvv`, `pin`, `member`, …) come with the phrases IVRs use to ask for them, and secret keys go straight to the vault:
   ```json
   { "custom": { "to": "+1…", "business": "…", "kind": "pay_bill", "goal": "Pay the current balance",
       "user": { "name": "…" }, "max_amount": 200, "business_line_attested": true,
       "facts": { "zip": "…", "account": "…", "card.number": "…", "card.exp": "…", "card.cvv": "…" } } }
   ```
Status: written against Twilio's documented ConversationRelay protocol (`sendDigits`, `text`, `end` + `handoffData`, `<Connect action>`), with signatures checked against Twilio's published test vector. It has not been run on a live account yet, so expect to tune endpointing (`ENDPOINT_MS`) and `hints` on real IVR audio.

## Hand-mapping phone trees

`maps/*.json` seeds the shared map when the server boots. That's how the top-50 IVRs get mapped before users arrive. See [maps/README.md](maps/README.md).

## Repo layout

```
src/core       session, IVR map, vault, parsers, custom tasks
src/brains     rules navigator, Claude navigator, shared prompt
src/sim        phone-tree simulator + four fictional businesses
src/server     REST, OAuth, remote MCP, OpenAPI, call manager
src/mcp        stdio MCP server
src/telephony  Twilio ConversationRelay line
web/           demo app (runs in-browser or against the server)
demo/          standalone demo page + launch video
integrations/  Muse connector kit, OpenClaw skill
docs/PITCH.md  the startup memo
```
