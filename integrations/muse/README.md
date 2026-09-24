# Voiced × Muse

Muse opened to third-party connectors on September 18, 2026 (muse.ai/platform). Voiced is the connector for everything Muse can't do in a browser: **calls to businesses**. Paying a utility bill through a phone tree, cancelling a membership, getting past a hold queue to a person.

Why this fits Muse right now: reports say businesses hang up on Muse's AI caller, and Meta paused a test that used human contractors to place calls. Voiced has the AI handle the machine part (the phone tree, account lookup, payment) and hands the user a briefed human only when a person picks up. No contractors, and secrets stay out of the model.

## Connecting today (custom connector)

Accounts of how Muse builds custom connectors differ, so Voiced supports every path that's been reported:

| Path | What to give Muse |
|---|---|
| **Remote MCP + OAuth** (reported to match Claude's connector flow: dynamic client registration + PKCE) | `https://<your-host>/mcp`. Muse discovers `/.well-known/oauth-protected-resource`, registers itself, and sends the user to Voiced's consent page. |
| **OpenAPI + API key** (Muse builds the connector from a public spec and stores a bearer token in its Secure Credentials Store) | Spec: `https://<your-host>/openapi.json`. Credential: `Authorization: Bearer <VOICED_API_KEY>` |
| **Muse Code** (streamable HTTP with static headers) | URL `https://<your-host>/mcp`, header `Authorization: Bearer <VOICED_API_KEY>` |

Custom connectors aren't reviewed by Meta, so they work immediately for testing.

## Directory submission kit (draft)

Directory connectors go through a three-step review: functional, security and legal requirements, plus end-to-end testing by Meta. Meta hadn't published developer terms, fees or review times as of September 19.

**Name:** Voiced

**Short description:** Voiced makes phone calls to businesses for you: phone trees, bill payments, cancellations and hold queues.

**Long description:** Ask Muse to pay a bill, cancel a membership or reach a person at a company that only helps by phone. Voiced calls, gets through the phone tree, enters your account details from a secure vault (Muse never sees your card number or PIN), pays within the limit you approve, waits on hold, and connects you when a person picks up. Every call starts with Voiced identifying itself as an AI assistant. Anything that costs more than you approved comes back to you first.

**Example prompts:**
- "Pay my Bedford utilities bill, up to $200."
- "Cancel my gym membership and don't let them talk me into a freeze."
- "Get me a human at my phone company about the $49.99 charge."

**Tools:** `list_businesses` (read) · `start_call` (places a call; payments capped by `max_amount`) · `get_call` (read; long-polls) · `respond_to_call` (relays the user's explicit decision) · `hang_up` · `get_stats` (read)

**Auth:** OAuth 2.1 authorization code with PKCE and dynamic client registration; scope `calls`. Consent page lists exactly what Muse may do.

**User safety:**
- Money moves only within a user-set cap; unapproved fees and amounts return to the user as a `pending_request` with a hosted `approval_url`.
- Tool descriptions tell the agent never to approve on the user's behalf.
- Voiced discloses it is an AI to every person it speaks with, and never reads secrets aloud to a person.
- Card data, PINs and account numbers never enter model context or transcripts. CVVs are wiped when the call ends.

**Data handling:** Voiced keeps business-side phone-tree structure (menus and which options work) to make future calls faster. It does not store the user's conversation with a live representative; processing stops at handoff. Call records keep outcome, duration and redacted transcript.

**Reviewer test plan** (runs against the simulated directory, no real calls or charges):
1. Connect the connector; approve the consent screen.
2. "Pay my Bedford utilities bill, up to $200." → expect a `pending_request` for a $2.95 card fee → approve → expect confirmation `4820177`.
3. Repeat step 2 → expect the same result, faster, with `metrics.map_hits` > 0.
4. "Cancel my gym membership." → expect confirmation `CX44190`, with both retention offers declined in the transcript.
5. "Get me a human at Kestrel Wireless." → expect status `user_connected` after the (fast-forwarded) hold, and a briefing naming the $49.99 charge.

**Before submitting:**
- [ ] Deploy with public HTTPS; set a strong `VOICED_API_KEY`
- [ ] Privacy policy and terms URLs (drafts needed)
- [ ] Logo and support contact
- [ ] Counsel review: TCPA (business service lines only, AI disclosure), recording-consent states, PCI scope
- [ ] Real-call pilot on Twilio with the top billers mapped
- [ ] Rate limits per user and per client
