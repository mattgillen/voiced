# Voiced

**The phone is the last mile for AI agents.**

AI agents can browse, email and check out. They still can't get through a phone tree. Voiced is the connector that lets an agent pay the utility bill, cancel the gym, dispute the charge or reach a human by phone: it navigates the IVR, keys account details from a vault the model never sees, waits on hold, and hands the user a briefed human when one is needed.

Go-to-market: a **Muse connector**, free for consumers and funded by venture capital. The long-term asset is a **shared map of the world's phone trees**, measured by one number: **call completion rate**. The exit is an acquisition by a frontier lab or agent platform that needs the last mile and can't rebuild the map overnight.

*Draft, September 2026. Figures with a source link were found through web search in September 2026 (most source pages could not be opened directly from our research environment, so spot-check them before sending). Figures marked **assumption** are placeholders to replace with sourced data.*

---

## The problem

*Founder's story (edit to taste):* I pay my Bedford utilities bill by phone. "Enter your ZIP code." "Enter your ten-digit account number, followed by pound." "Sorry, I didn't get that." Then the card: sixteen digits, expiration, security code, billing ZIP, "press 1 to authorize." One wrong key and it's back to the main menu. I work on enterprise IVRs for a living. I know why the tree is shaped this way, and a machine could still do it faster than me.

That's the easy call. The hard one is 40 minutes of hold music to cancel something or dispute a charge.

- Hidden fees and time on hold (the "annoyance economy") cost U.S. families **≥$165B a year**, and time spent with customer service is up **60%** in two decades ([Groundwork Collaborative](https://groundworkcollaborative.org/news/hidden-fees-and-wasted-time-new-report-shows-the-annoyance-economy-costs-americans-165-billion-a-year/)).
- The phone channel isn't going away: **~2.8M** U.S. customer service representatives ([BLS](https://www.bls.gov/ooh/office-and-administrative-support/customer-service-representatives.htm)), **~17M** contact-center agents worldwide ([Gartner](https://www.gartner.com/en/newsroom/press-releases/2022-08-31-gartner-predicts-conversational-ai-will-reduce-contac)), and a **~$5.4–6B** IVR software market ([Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/interactive-voice-response-market), [MarketsandMarkets](https://www.marketsandmarkets.com/Market-Reports/interactive-voice-response-ivr-market-131935293.html)).

## Why now: agents got phones this month, and they're failing at the hard part

1. **Muse opened to connectors on September 18.** Developers can submit connectors at muse.ai/platform; Meta reviews them for functional, security and legal requirements, runs end-to-end tests, and lists approved ones in a directory, with Stripe Link for payments ([Social Media Today](https://www.socialmediatoday.com/news/meta-expands-muse-agent-connections-launches-muse-for-mac/830852/), [CryptoBriefing](https://cryptobriefing.com/meta-muse-developer-connector-api-access/)).
2. **Muse and Instinct both added calling** in September ([TechCrunch](https://techcrunch.com/2026/09/17/rival-ai-agents-instinct-and-metas-muse-both-add-the-ability-to-make-calls/)).
3. **Businesses hang up on the AI.** Meta quietly had human contractors place some Muse calls, which reportedly lifted success to **95–98%**, then rolled the test back over privacy concerns and a contractor's racist remark ([Reuters via BNN Bloomberg](https://www.bnnbloomberg.ca/business/artificial-intelligence/2026/09/22/meta-testing-a-human-concierge-for-its-new-personal-ai-agent-muse-reuters-exclusive/), [PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/meta-tests-human-callers-for-muse-after-merchants-hang-up-on-ai/)). That is the gap: the platforms need a reliable, non-human way to finish phone tasks.
4. **Customers already bring their own AI.** They are **~3x** more likely to use third-party GenAI than a company's chatbot for service ([Gartner, Jul 2026](https://www.gartner.com/en/newsroom/press-releases/2026-07-08-gartner-survey-finds-customers-are-three-times-more-likely-to-use-third-party-genai-than-company-provided-chatbots-for-customer-service)), and **87%** still want a path to a human ([Gartner, Aug 2026](https://www.gartner.com/en/newsroom/press-releases/2026-08-04-gartner-survey-finds-87-percent-of-customers-say-companies-using-genai-for-customer-service-must-provide-access-to-a-human-agent0)).
5. **Voice infrastructure is a commodity.** Vapi reports **1B+** calls handled ([GlobeNewswire](https://www.globenewswire.com/news-release/2026/05/12/3292882/0/en/vapi-raises-50m-series-b-as-it-reaches-1-billion-calls-powering-the-next-generation-of-enterprise-voice-ai.html)). What's scarce is reliability at a specific company's phone tree.

## The insight

**Let the AI talk to machines, and put humans with humans.** Phone trees are machines: static, shared and indifferent to who's calling, so an agent can get through them reliably. Live reps are where AI callers get hung up on. Voiced does everything up to the human, then briefs the rep and hands the call to the user. It skips both the hang-up problem and the human-contractor problem.

**Phone trees are shared, so a map of them compounds.** Every agent today rediscovers each tree live, with a model listening to every prompt. Voiced remembers the tree (prompt fingerprint → option → outcome). The next call to that number, from any user on any agent, skips the listening: faster, cheaper, more reliable. The map is a cache with a network effect, and it is the asset.

**The calls worth making are authenticated.** Account numbers, PINs, cards. General-purpose agents can't safely put those in model context. Voiced's model never sees them.

## Product

1. **The Muse connector (go-to-market).** A user tells Muse "pay my Bedford bill"; Muse calls Voiced; Voiced makes the call and comes back with a confirmation number, or a push asking the user to approve an unexpected fee. Free to consumers.
2. **Developer API + MCP (the core product).** One tool for every agent platform: Muse, Claude, ChatGPT-style assistants, Instinct, OpenClaw. REST with an OpenAPI spec, remote MCP with OAuth, local MCP over stdio.
3. **Agent Gateway (enterprise, later).** When agent calls arrive in volume, businesses will want a sanctioned machine lane (a DTMF fast path, a SIP header, an API) with agent identity, policy and analytics. That makes the market two-sided, and it is the largest piece.

The consumer demo is marketing and data: it fills the map and produces the completion numbers that sell the API.

## What's built (this repo)

A working end-to-end demo, not a mockup:

- **Call engine** that listens, decides and acts over a telephony-agnostic line: menus, keypad entry, speech prompts, identity checks, commit steps, retention offers, hold queues, live humans.
- **The shared IVR map**: learns every tree it navigates and replays known screens on the next call with barge-in. On the simulated utility line, the second call is 30 seconds shorter with 9 screens replayed and zero model calls. Built only from automated prompts and keypresses, never from human speech.
- **The vault**: the model emits `{{card.number}}`, and the runtime fills in the digits at the last moment. Transcripts are redacted, and the CVV is wiped at hangup. Tests assert that no secret appears in any event.
- **Policy in code**: money beyond the pre-approval and unapproved fees always come back to the user, even if the model tries to press "1".
- **Live handoff**: disclose AI, brief the rep, bridge the user in.
- **The connector surfaces**: REST + OpenAPI, remote MCP with OAuth 2.1 (dynamic registration + PKCE), stdio MCP, hosted approval links.
- **Brains**: a deterministic rules navigator (100% completion on the four simulated trees) and a Claude navigator, with the rules as fallback.
- **Twilio ConversationRelay line** for real calls with warm transfer. It's written and tested against the protocol, but **not yet run against a live account**.

## Business model: free now, acquisition later

Consumers pay nothing. That maximizes calls, and calls build the map and the completion data an acquirer will pay for. What we keep is **business-side**: phone-tree structure, which options work, where calls fail. User PII is not the asset. Harvesting it would be a legal liability (see *Ambriz v. Google* below) and a diligence red flag.

**What free costs (assumption).** Modeling a 12-minute bill-pay call (4 min IVR, 6 min hold, 2 min human, plus a handoff leg):

| Cost line (rate source) | First call to a tree | Map hit |
|---|---|---|
| Telephony @ $0.014/min ([Twilio](https://www.twilio.com/en-us/voice/pricing/us)) | $0.20 | $0.16 |
| ConversationRelay @ $0.07/min (Twilio pricing page, per our Twilio research) | $0.84 | $0.67 |
| LLM @ ~$0.03 per active minute (assumption, from [Retell rates](https://www.cekura.ai/blogs/retell-ai-pricing-per-minute)) | $0.18 | $0.06 |
| **Total** | **~$1.22** | **~$0.89** |

Running STT/TTS ourselves instead of ConversationRelay (Deepgram at ~$0.0077/min, per [this summary](https://convertaudiototext.com/blog/deepgram-nova-3-explained)) brings a call to roughly **$0.30–0.50**. So **$1M of runway covers roughly 1–3M completed calls**. Hold minutes, not the model, are the biggest cost: a later optimization is to not keep a paid media stream open during hold music.

**Revenue options kept open:**

| Line | Hypothesis |
|---|---|
| Developer API | $0.50–$1.00 per **completed** call. Failed calls are free, so pricing tracks the headline metric. |
| Platform deals | Per-call or rev-share with agent platforms that want Voiced built in. |
| Consumer | Free. A paid tier ($5–10/mo) stays an option if the exit path changes. |
| Agent Gateway | Enterprise platform + per-session fees, priced below a human-handled call (median CSR wage $20.59/hr, [BLS](https://www.bls.gov/ooh/office-and-administrative-support/customer-service-representatives.htm)). |

## Market size (bottom-up; every input is an assumption to replace)

- **Developer API** = (agent calls to businesses per year) × (completion rate) × ($0.50–$1.00). *Illustrative:* 1B agent calls a year × 60% completed → **$300–600M/yr**.
- **Consumer** = (U.S. households, about 130M) × (paying share) × ($60–120/yr). *Illustrative:* 1–2% paying → **$80–310M/yr**. We are deliberately not taking this revenue at launch.
- **Agent Gateway** = the largest and longest-term piece: a share of the per-call cost contact centers pay today, applied to the fraction of calls that become agent-to-agent. We'll size it with enterprise design partners rather than guess.

## Exit thesis

The buyers are the companies whose agents need the last mile: Meta (Muse), OpenAI, Anthropic, Google, Instinct. What they'd be buying:

1. **The map**: thousands of mapped phone trees with live completion data. Any lab can build a caller; nobody can instantly reproduce a mapped world.
2. **Completion rate**: proof, business by business, that calls finish.
3. **The compliance and trust layer**: vault, approvals, disclosure, recording consent, PCI posture. This is exactly where Meta's human-concierge experiment went wrong.
4. **The enterprise side**: Gateway relationships with the businesses on the other end of the call.

## Competition

**What changed in September 2026:** Google, Meta, Instinct and Apple are converging on a free "call for me" button. Voiced wins as the **layer under those agents**, focused on authenticated transactions.

| Player | What it does | Voiced vs. it |
|---|---|---|
| Google Talk to a Live Rep + Gemini "Call for me" | Navigates trees for listed companies ([9to5Google](https://9to5google.com/2024/02/15/google-talk-live-representative/)); Phone-app code shows Gemini working support lines ([Android Authority](https://www.androidauthority.com/google-gemini-call-for-me-apk-teardown-3713510/)) | **High threat.** We win on authenticated transactions, iPhone users, and a cross-agent API |
| Pixel Hold for Me / iOS 26 Hold Assist | Waits on hold after *you* navigate ([Google](https://blog.google/products/pixel/pixel-call-assist-call-notes-tips/), [MacRumors](https://www.macrumors.com/how-to/ios-26-make-your-iphone-wait-on-hold-for-you/)) | No navigation or payment; makes hold-waiting a free feature |
| Google Ask for Me / Duplex | Calls local businesses for price and availability ([TechCrunch](https://techcrunch.com/2025/01/30/googles-ask-for-me-feature-calls-businesses-on-your-behalf-to-inquire-about-services-pricing/)) | Gathers information; doesn't service accounts; no API |
| Meta Muse / Instinct Concierge | General agents that now place calls; Instinct valued at $2.5B ([TechCrunch](https://techcrunch.com/2026/08/26/viral-ai-startup-instinct-has-raised-350-million-at-a-2-5-billion-valuation/)) | Our distribution and our likeliest acquirers, but they could build it themselves |
| **Pine AI** | Consumer agent for bills and disputes, $25M Series A ([BusinessWire](https://www.businesswire.com/news/home/20251203384902/en/Pine-Secures-$25-Million-in-Series-A-Funding-to-Free-Consumers-of-Digital-Chores-Saving-Time-and-Money-and-Eliminating-Frustration)); already has an MCP server and an OpenClaw plugin ([PineClaw](https://pineclaw.com/)) | **Closest competitor on both fronts.** We must win on completion rate, cost, secret-safe payments and being first in the Muse directory |
| **GetHuman for Business** | Dials, navigates, holds, then rings in your human *or AI agent*, billed per live connection ([GetHuman](https://advocate.gethuman.com/)) | **High threat** to "reach a human"; we finish the task before any human is needed |
| Vapi, Retell, Bland, ElevenLabs, Twilio ConversationRelay, OpenAI Realtime | Voice infrastructure with IVR primitives ([Vapi](https://docs.vapi.ai/ivr-navigation), [Retell](https://www.retellai.com/features/navigate-ivr), [ElevenLabs](https://elevenlabs.io/blog/introducing-ivr-phone-tree-navigation)) | Our suppliers. Threat if one builds a shared map |
| Sierra | Enterprise agents that navigate IVRs, as of Aug 2026 ([Sierra](https://sierra.ai/blog/navigating-ivr-systems)) | Business-side; a possible Gateway rival or partner |
| Infinitus / SuperDial | Healthcare IVR agents; Infinitus's payor graph comes from 4M+ calls ([PR Newswire](https://www.prnewswire.com/news-releases/infinitus-systems-raises-51-5-million-series-c-funding-on-the-strength-of-ai-guardrails-302283847.html)) | **Proof that the map moat works** in one vertical |
| Simple AI (YC S24) | Consumer "calls for you" app that pivoted to business-side agents ([BusinessWire](https://www.businesswire.com/news/home/20260210526354/en)) | Warning that consumer calling is hard to monetize, which is why we're not trying to |
| DoNotPay | "Skip Waiting on Hold" (2019); later an FTC order over its AI claims ([FTC](https://www.ftc.gov/news-events/news/press-releases/2025/02/ftc-finalizes-order-donotpay-prohibits-deceptive-ai-lawyer-claims-imposes-monetary-relief-requires)) | The lesson: publish real completion rates |

## Risks, stated plainly

- **Apple and Google own the dialer** and already ship hold features. *Mitigation:* be the cross-platform layer agents call, not a dialer, and go deeper than they will on authenticated transactions.
- **Voice-infra companies (Vapi, Retell, Bland) or the big labs could build this.** *Mitigation:* speed plus the map. Every month of calls widens the gap, and a lab that could build it is also the likeliest buyer.
- **Consumers don't call often enough to keep paying.** *Mitigation:* we don't ask them to. Free consumer use builds the map; revenue comes from developers, platforms and the exit.
- **Platform risk with Muse.** Meta controls the directory and could build this. *Mitigation:* ship MCP and OpenAPI so every agent platform works on day one; be the best at completion so building it in-house loses to buying.
- **TCPA.** AI voices count as "artificial" ([FCC 24-17](https://docs.fcc.gov/public/attachments/FCC-24-17A1.pdf)), with $500–$1,500 per call in damages ([47 U.S.C. §227](https://www.law.cornell.edu/uscode/text/47/227)). The rule targets robocalls to consumers, and a user-initiated service call to a business line is different. *Mitigation:* dial only business service lines, never market, disclose AI on every call, get a counsel opinion.
- **Recording and CIPA.** All-party-consent states include CA, FL, IL, MD, MA, PA and WA ([DMLP](https://www.dmlp.org/legal-guide/recording-phone-calls-and-conversations)). *Ambriz v. Google* treats an AI vendor that *can* use call data for its own benefit as an eavesdropper ([Goodwin](https://www.goodwinlaw.com/en/insights/publications/2025/02/alerts-practices-dpc-ftec-ai-voice-products-subject-to-california-invasion-of-privacy-claims)), which is close to describing a map. *Mitigation (already in the code):* the map learns only from automated prompts and keypress outcomes, never from human speech, and Voiced stops processing audio the moment the user is bridged in.
- **Businesses block bots.** *Mitigation:* disclose honestly, never impersonate, hand humans to humans, track hang-up-on-AI rate weekly, and offer the Gateway as a sanctioned lane.
- **PCI.** No CVV retention after authorization ([PCI SSC](https://blog.pcisecuritystandards.org/faq-can-cvc-be-stored-for-card-on-file-or-recurring-transactions)). *Mitigation:* a tokenizing vault provider; card data kept out of logs and model context (tested).
- **Hallucinated actions.** *Mitigation:* the policy guard in code, approval gates, and a receipt after every call.
- **Founder conflict.** Review the employment and IP agreement; build clean-room, with none of the employer's data or code.

## Metrics

- **Headline: call completion rate**, overall and per phone tree. Every other number explains it.
- **Moat:** trees mapped, share of call volume on mapped trees, map-hit rate, % of calls with no model navigation, map drift (screens that changed).
- **Speed and cost:** time to target, time to human, cost per **completed** call.
- **Trust:** secret exposures and unapproved money movements (target: zero), hang-up-on-AI rate.
- **Distribution:** calls from Muse, calls from third-party agents via API/MCP, developers with live integrations.

## The YC plan

- **This week:** launch the demo video (recorded from this repo: `demo/voiced-demo.mp4`). Submit the Muse connector.
- **Next 30 days:** **hand-map the top 50 IVRs** (utilities, telcos, cable, insurers, gyms; `maps/` is the seed format); first real calls on Twilio; counsel memo on TCPA/CIPA.
- **Next 90 days:** **10 developers building agents that make real calls** through Voiced; Muse directory listing live; completion rate published per tree; 1,000 completed calls a week.

## YC short answers

**What are you making?** The phone layer for AI agents. Agents like Muse call Voiced when a task needs a phone call: it gets through the phone tree, enters account details from a vault the model never sees, pays with the user's approval, waits on hold, and hands the user a briefed human.

**Why you?** I work on the enterprise IVR side. I know how the trees are designed, why they change, what contact centers fear about bots, and what they would buy. That's both sides of the protocol.

**What's the insight?** Phone trees are machines, and machines are the part an AI can reliably handle. And because trees are shared, a map of them compounds: every call from every user makes the next one faster and cheaper.

**How will you make money?** Consumers are free. Developers pay per completed call; platforms pay for built-in access; enterprises pay for the Gateway. The endgame is being acquired by the agent platform that needs the last mile most.
