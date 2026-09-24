# Voiced

**The phone layer for AI agents.** Your agent says "pay my Bedford utilities bill." Voiced makes the call: it gets through the phone tree, keys the account and card from a vault the model never sees, pays within the limits the user approved, waits on hold, and hands the user a briefed human when one is needed.

- **For agent platforms and developers:** REST + OpenAPI, remote MCP with OAuth, local MCP over stdio. Built to plug into Muse's connector platform and anything else that speaks MCP.
- **The moat:** a shared map of phone trees. Every call teaches Voiced the tree, so the next call to that number (from any user, on any agent) replays the known screens instead of listening to them.
- **Headline metric:** call completion rate (`GET /v1/stats`, `npm run eval`).

Strategy, market and risks are in [docs/PITCH.md](docs/PITCH.md). The demo video is [demo/voiced-demo.mp4](demo/voiced-demo.mp4).

> **What's real in this build.** The call engine, map, vault, policy guard, API, MCP and OAuth all run end to end. The four businesses are **simulated phone trees** (fictional companies, 555-01xx numbers, public test cards). The Twilio line for real calls is written and protocol-tested but has **not yet been run against a live Twilio account**. The Claude brain is wired and unit-tested with a stubbed client; run it live with `ANTHROPIC_API_KEY`.

## Quick start

```bash
npm install
npm test                    # 27 tests: engine, map, vault, guard, server, OAuth + MCP, Twilio protocol
npm run sim bedford         # watch one call in the terminal
npm run sim all -- --twice  # every tree, twice: the second run replays the map
npm run eval                # completion rate per tree, cold vs. warm map
npm run build:web && npm start   # web app + API + MCP on http://localhost:8787
```

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

## Configuration

| Env | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `PUBLIC_URL` | `http://localhost:PORT` | public https base; required for connectors and Twilio |
| `VOICED_API_KEY` | `vk_demo_local` | developer key; change it anywhere public |
| `ANTHROPIC_API_KEY` | unset | enables the Claude brain (`VOICED_BRAIN=rules` to force rules) |
| `VOICED_MODEL` / `VOICED_EFFORT` | `claude-opus-5` / `low` | |
| `VOICED_DATA` | `.voiced/` | map store and call log |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER`, `VOICED_USER_PHONE` | unset | enables real calls (`custom` tasks on `POST /v1/calls`) |

### Making real calls (Twilio)

1. In the Twilio Console, enable the *Predictive and Generative AI/ML Features Addendum* (ConversationRelay won't run without it).
2. Set the Twilio env vars and `PUBLIC_URL` (https; Twilio connects to `wss://<host>/twilio/relay`).
3. Start a call with a custom task. Standard fact keys (`zip`, `account`, `card.number`, `card.exp`, `card.cvv`, `pin`, `member`, …) come with the phrases IVRs use to ask for them, and secret keys go straight to the vault:
   ```json
   { "custom": { "to": "+1…", "business": "…", "kind": "pay_bill", "goal": "Pay the current balance",
       "user": { "name": "…" }, "max_amount": 200,
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
