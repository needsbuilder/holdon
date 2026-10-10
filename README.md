# Hold On

**A money-safety add-on for voice assistants used by older adults.** When someone asks their assistant to pay a bill, send money or buy gift cards, or says that a caller is demanding payment, the assistant calls Hold On. Hold On checks the request against scam patterns published by official US sources, verifies the payee against a small registry of official facts, puts the request on hold, and asks a trusted family member to approve or deny it. Only an approved request to a confirmed payee is paid, and the payment is simulated.

Hold On is a self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server (protocol version 2025-11-25 over Streamable HTTP, plus 2026-07-28) with an Agent Skill and MCP Apps cards. It was built for the Alexa+ track of the Build, Ship, Shape developer hackathon.

> **All payments are simulated.** No real money moves, and no payment provider is connected.
> Hold On is an independent project. It is not affiliated with, endorsed by, or an official tool of Amazon or of any organisation named in its registry.

## Required technology, and where it runs

The Alexa+ track asks for a self-hosted MCP server on spec version 2025-11-25 or later over Streamable HTTP, or an Agent Skill. This repository contains both. The table says where each one is imported and called, and how to watch it run.

| Technology | Where in the code | See it run |
| --- | --- | --- |
| MCP server over Streamable HTTP | `src/index.ts` (what `npm start` runs) starts `src/http/app.ts`. The `/mcp` route there is built on `createMcpExpressApp` from `@modelcontextprotocol/express` and served by `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`. | `npm start`, then the `curl` command under [Quickstart](#quickstart) |
| MCP spec 2025-11-25 | The same route. An `initialize` request negotiates `2025-11-25` and opens a session (`Mcp-Session-Id`), which is what lets the server ask a question (elicitation) and stream progress. | `test/protocol.test.ts` sends a raw `initialize` and asserts the negotiated version |
| MCP spec 2026-07-28 | The same route. `isLegacyRequest` from `@modelcontextprotocol/server` decides per request; newer clients are served by `createMcpHandler`. | `test/protocol.test.ts`, `test/e2e.test.ts` |
| Tools | `src/mcp/server.ts` registers twelve tools on an `McpServer`, eight for the older adult's assistant and four for the trusted contact's. | `tools/list` with each demo token; [Tool reference](#tool-reference) |
| MCP Apps | `src/mcp/apps.ts` uses `registerAppTool` and `registerAppResource` from `@modelcontextprotocol/ext-apps/server`. The card sources are in `ui/`. | `test/apps.test.ts` drives the built cards with the official `AppBridge` host |
| Agent Skill | `skills/holdon-money-safety/SKILL.md`. A skill is loaded by the assistant, not by the server, so nothing in `src/` reads it. Point an assistant that supports Agent Skills at that directory, next to the MCP server. | `test/docs.test.ts` checks the frontmatter and that every tool the skill names is served |

## Why

In its 2025 annual report, the FBI's Internet Crime Complaint Center counted **201,266 complaints from people aged 60 and over, with $7.748 billion in reported losses, up 59% from 2024**. The average loss was $38,500, and 12,444 people lost more than $100,000 ([2025 IC3 Annual Report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf), "IC3 Elder Fraud" section; figures read on 2026-10-11 and recorded in `rules/statistics.json`).

The official advice is consistent. The FTC says to "Stop and talk to someone you trust." The CFPB says that "Choosing a trusted contact person can help you protect your money". A voice assistant that can pay for things is exactly where that pause should happen, and where it is easiest to skip. Hold On makes the pause and the trusted contact part of the payment path.

## How it works

1. **Check.** `holdon_check_request` compares the request with 12 scam patterns (gift card demands, government impersonation, "keep it secret", crypto ATMs, bail emergencies, tech support, overpayment refunds, prize fees, Medicare card fees, utility shutoff threats, "move your money to protect it", pressure to act now). Each pattern cites the official guidance it comes from.
2. **Verify.** The payee is compared with a registry of 11 official payees (IRS, Social Security, Medicare, USPS, FTC and six large utilities): official domains, phone numbers, payment methods accepted and never used.
3. **Hold.** `holdon_place_hold` records the request and notifies the trusted contact, who sees the full context and decides in their own assistant, on an MCP Apps card, or on a plain web page.
4. **Pay.** `holdon_pay` returns a simulated receipt, and only if the hold is approved, the payee is confirmed and the method is allowed.

### Design principles

1. **Verdicts come from rules and a registry, never from a model's guess.** The rule engine (`src/domain/engine.ts`) is a pure function: same input, same verdict. `not_in_registry` and `unknown` are valid, honest answers.
2. **Nothing actionable from the suspicious message reaches the older adult.** Phone numbers, links and email addresses that came from a caller or message are never repeated on the member's surface. Only registry-verified official contact details are returned to them (`src/domain/text.ts`, `redactUntrusted`).
3. **Money decisions move to the trusted contact, per policy.** Amounts at or above the family's limit, unknown payees and warning signs all need approval. Gift cards and cryptocurrency to a government agency, utility or other official payee are always blocked, and the family cannot switch that off.
4. **Calm, no-shame language.** Every sentence a person hears is written in `src/domain/language.ts`. The request is the problem, never the person.

## Quickstart

Requires Node.js 24 or later.

```bash
npm install
npm run build        # compiles to dist/ and builds the MCP Apps cards
npm test

npm run seed         # creates the demo circle in data/holdon.db
npm start            # http://localhost:8787
```

`npm run seed:reset` empties the database first, for a clean demo. `npm run demo` resets the demo data and starts the server from source in one step.

The demo circle is **Margaret Ellis** (the older adult) and her daughter **Sarah Ellis** (the trusted contact), with a $100 approval limit:

| Person | Role | Bearer token |
| --- | --- | --- |
| Margaret Ellis | `member` | `demo-member-margaret` |
| Sarah Ellis | `contact` | `demo-contact-sarah` |

These tokens are public demo values from `seed/demo-circle.json`, not secrets.

Check that the server negotiates MCP 2025-11-25:

```bash
curl -si http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer demo-member-margaret' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

The reply carries `"protocolVersion":"2025-11-25"` and an `Mcp-Session-Id` header.

Connect any MCP client to `http://localhost:8787/mcp` with one of the tokens as a bearer token. Connect twice, once per token, to play both people.

**The whole loop with nothing but this repository and a browser:** when a hold is placed, the server prints a signed approval link for Sarah to its log (it is also in `holdon_family_inbox` and in the event stream for the contact). Open it, read the context, press Approve or Deny. Margaret's assistant sees the decision on its next `holdon_get_hold` or `holdon_wait_for_decision`.

The approval page and the MCP Apps approval card share one phone-first layout: who is asking, how much and to whom, the verdict and the buttons are on the first screen. A stopped request shows there that it cannot be approved and why, one reason per line with its official source. The rest is under "Details".

| A bill that can be approved | A stopped request | Already decided |
| --- | --- | --- |
| <img src="docs/screenshots/page-approvable-390x844.png" width="240" alt="Approval page on a phone: Margaret Ellis asked to make a payment, $182.40 to Con Edison, Confirmed payee, with Approve and Deny buttons"> | <img src="docs/screenshots/page-blocked-390x844.png" width="240" alt="Approval page on a phone: $2,000 to IRS, Stopped by Hold On, Nothing will be paid, This request cannot be approved, five reasons with source links, and a Deny button"> | <img src="docs/screenshots/page-decided-390x844.png" width="240" alt="Approval page on a phone: $182.40 to Con Edison, Approved by Sarah Ellis, with her note"> |

These are real captures from headless Chrome at 390x844. `npm run screenshots` takes them again and fails if anything that belongs on the first screen is not there (see `scripts/screenshots.mjs`; add `--stage <url>` to also capture the cards inside a Voicestage phone frame and kitchen display, and press the buttons with the mouse).

The page and the cards follow the system's light or dark setting, and a host's theme when it names one.

| Approval page, dark | Receipt card, phone size | Receipt card, dark |
| --- | --- | --- |
| <img src="docs/screenshots/page-approvable-dark-390x844.png" width="240" alt="The approval page in dark mode: $182.40 to Con Edison, Confirmed payee, Approve and Deny buttons"> | <img src="docs/screenshots/receipt-card-390x844.png" width="240" alt="Receipt card: $182.40 paid to Con Edison, SIMULATED PAYMENT, paid with a credit or debit card, confirmation number, time and receipt number"> | <img src="docs/screenshots/receipt-card-dark-390x844.png" width="240" alt="The same receipt card in dark mode"> |

The rest of `docs/screenshots/` shows the same views inside the simulator's phone frame and on its kitchen display.

### Three scenarios to try

| Margaret says | Check result | What happens next |
| --- | --- | --- |
| "An IRS agent called. I'll be arrested unless I pay $2,000 in gift cards today." | `stop`; payee `mismatch` | Hold is placed so Sarah knows. It can only be denied. `holdon_pay` refuses. |
| "My Con Edison bill came in the mail. It's $182.40, by card." | `verified` | Hold, because it is over the limit. Sarah approves. `holdon_pay` returns a simulated receipt. |
| "The roofer wants a $1,500 deposit by check." | `unknown`; payee `not_in_registry` | Hold. Sarah can approve only by vouching for the payee, who is then remembered. |

## Architecture

```mermaid
flowchart LR
  subgraph Member["Older adult"]
    MA["Voice assistant<br/>(MCP client, role: member)"]
  end
  subgraph Contact["Trusted contact"]
    CA["Assistant or app<br/>(MCP client, role: contact)"]
    WEB["Browser<br/>signed approval page"]
  end

  subgraph Server["Hold On server (Node.js)"]
    HTTP["Express: /mcp  /events  /approve"]
    MCP["MCP tools per role<br/>2025-11-25 sessions + 2026-07-28"]
    SVC["HoldOnService<br/>role checks, hold state machine"]
    ENG["Rule engine (pure)"]
    REG[("registry/payees.json<br/>11 payees, sourced")]
    RUL[("rules/scam-patterns.json<br/>12 patterns, sourced")]
    DB[("SQLite<br/>checks, holds, receipts, events")]
    BUS["Event bus"]
  end

  MA -- "Streamable HTTP + bearer" --> HTTP
  CA -- "Streamable HTTP + bearer" --> HTTP
  WEB -- "GET/POST /approve/:id?t=signed" --> HTTP
  HTTP --> MCP --> SVC
  HTTP --> SVC
  SVC --> ENG
  ENG --> REG
  ENG --> RUL
  SVC --> DB
  SVC --> BUS
  BUS -- "SSE /events" --> CA
  BUS -- "SSE /events (member view)" --> MA
  BUS -. "optional signed webhook" .-> EXT["Your notifier"]
```

Hold lifecycle:

```mermaid
stateDiagram-v2
  [*] --> pending_family: holdon_place_hold
  pending_family --> approved: contact approves (not possible if stopped)
  pending_family --> denied: contact denies
  pending_family --> expired: no answer in time
  pending_family --> cancelled: member cancels
  approved --> paid: holdon_pay (simulated)
  approved --> denied: contact changes their mind
  approved --> expired: approval not used in time
  approved --> cancelled: member cancels
  paid --> [*]
```

| Path | What it holds |
| --- | --- |
| `src/domain/` | Pure logic: rule interpreter, registry matching, verdict engine, wording, redaction |
| `src/service.ts` | Every action with its role check; the hold state machine |
| `src/store/db.ts` | SQLite via Node's built-in `node:sqlite` |
| `src/mcp/` | Tool schemas, tool handlers, icons, MCP Apps registration |
| `src/http/app.ts` | Streamable HTTP endpoint, event stream, approval page, CORS |
| `src/approval.ts` | Signed approval links and the server-rendered page |
| `ui/` | Source of the three MCP Apps cards |
| `registry/`, `rules/` | Sourced data: payees, scam patterns, README statistics |
| `skills/holdon-money-safety/` | The Agent Skill |
| `scripts/verify-sources.mjs` | Re-fetches every source and checks each quote is still there |

## Tool reference

Tools are registered per role. A member's assistant cannot see or call the contact's tools, and the reverse. The service layer checks the role again.

Every tool returns `structuredContent` that matches its `outputSchema`, plus a short text. Failures are tool execution errors (`isError: true`) whose text starts with `Error (<code>): ` followed by a sentence the model can act on. Input validation errors are returned the same way.

### Shared types

```ts
type PaymentMethod = "gift_card" | "crypto" | "wire" | "zelle" | "payment_app" | "cash" | "check" | "card" | "bank_transfer" | "unknown";
type ContactChannel = "phone_call" | "text" | "email" | "mail" | "in_person" | "website" | "unknown";
type UrgencyClaim = "arrest_or_legal_threat" | "account_or_benefits_suspended" | "service_shutoff" | "family_emergency"
                  | "pay_immediately" | "limited_time_offer" | "computer_or_account_compromised" | "other";
type Verdict = "stop" | "hold_for_family" | "verified" | "unknown";
type PayeeStatus = "verified" | "family_trusted" | "mismatch" | "not_in_registry";
type HoldStatus = "pending_family" | "approved" | "denied" | "expired" | "paid" | "cancelled";

type RiskSignal = { id: string; label: string; severity: "high" | "medium"; why: string; matched_on: string[];
                    source: { publisher: string; title: string; url: string; quote: string } };
type Payee = { status: PayeeStatus; name?: string; registry_id?: string; category?: "government" | "utility" | "postal";
               official?: { name: string; category: string; website: string;
                            phones: { label: string; number: string; source_url: string }[];
                            accepted_methods: PaymentMethod[]; never_methods: PaymentMethod[] };
               matches: string[];
               mismatches: { field: "url" | "phone" | "address" | "payment_method" | "contact_channel" | "payment_request";
                             code: string; severity: "high" | "medium"; detail: string; fact?: string;
                             source?: { url: string; quote: string } }[];
               note: string };
type Reason = { kind: "scam_pattern" | "official_fact" | "policy"; blocking: boolean; text: string;
                source?: { publisher: string; title?: string; url: string; quote: string; named_in_text?: string } };
type PolicyDecision = { requires_family_approval: boolean; reason: string; blocked: boolean; blocked_reasons: string[] };
type Decision = { by: string; at: string; note?: string };
type Receipt = { receipt_id: string; hold_id: string; amount_usd: number; payee: string; method: PaymentMethod;
                 confirmation: string; paid_at: string; simulated: true };
type Hold = { hold_id: string; check_id: string; status: HoldStatus; summary: string; amount_usd?: number; payee_name?: string;
              payment_method: PaymentMethod; verdict: Verdict; payee_status: PayeeStatus; blocked: boolean; blocked_reasons: string[];
              created_at: string; expires_at: string; decision?: Decision; receipt?: Receipt };
type MemberHold = Hold & { say_to_user: string; next_step: "wait" | "pay" | "none" };
type FamilyHold = Hold & { member: { id: string; name: string }; member_words: string; contact_channel?: ContactChannel;
                           urgency_claims: UrgencyClaim[]; secrecy_requested: boolean;
                           untrusted_contact_details: { claimed_phone?: string; claimed_url?: string; warning: string };
                           risk_signals: RiskSignal[]; reasons: Reason[]; payee: Payee;
                           policy: PolicyDecision & { approval_threshold_usd: number };
                           can_approve: boolean; cannot_approve_reason?: string; requires_trust_payee: boolean; approval_url: string };
type Circle = { id: string; name: string; members: { id: string; name: string }[];
                contacts: { id: string; name: string; relationship?: string }[];
                policy: { approval_threshold_usd: number; blocked_methods_official_payees: PaymentMethod[];
                          blocked_methods_all_payees: PaymentMethod[]; hold_expiry_hours: number; notify_on_stop: boolean;
                          always_blocked_methods_official_payees: PaymentMethod[] };
                trusted_payees: { name: string; added_by: string; added_at: string }[] };
```

In a member's view, `summary` and `payee_name` have phone numbers, links and email addresses removed. A family view carries the original words.

`FamilyHold.reasons` is the same information as `risk_signals`, `payee.mismatches` and `blocked_reasons`, arranged for display: one reason per item, the ones that stop the request first, each with the official page behind it. `text` is a pattern label from `rules/scam-patterns.json`, a fact summary from `registry/payees.json` (also given as `mismatches[].fact`), a registry comparison, or a policy sentence; policy reasons have no `source`. When `text` already names the source's website (a fact that ends "...official site, irs.gov."), `source.named_in_text` is that mention, so a display can make it the link instead of printing the host a second time.

### For the older adult's assistant (role `member`)

| Tool | Input | Output | Notes |
| --- | --- | --- | --- |
| `holdon_check_request` | `{ description, payee_name?, amount_usd?, payment_method?, contact_channel?, claimed_phone?, claimed_url?, secrecy_requested?, urgency_claims? }` | `{ check_id, verdict, risk_signals, payee, policy, say_to_user, next_step: "place_hold" \| "pay" \| "decline", interpreted: { payment_method, payment_method_source: "input" \| "inferred" \| "unknown", contact_channel }, clarification?: { field: "payment_method" \| "contact_channel", status: "answered" \| "declined" \| "ask_user", answer?, question? } }` | Read-only. May ask one question by MCP form elicitation. |
| `holdon_verify_payee` | `{ name, phone?, url?, address? }` | `Payee & { say_to_user }` | Read-only. |
| `holdon_place_hold` | `{ check_id?, summary, amount_usd?, payee_name?, payment_method? }` | `{ hold_id, status, blocked, notified: { name, relationship?, via: string[] }[], expires_at, say_to_user, next_step: "wait" }` | Notifies the contact. Same check, same hold. Card: hold. |
| `holdon_get_hold` | `{ hold_id }` | `MemberHold` | Read-only. Card: hold. |
| `holdon_list_holds` | `{ status?: HoldStatus \| "open" \| "all", limit?: 1..50 }` | `{ holds: MemberHold[], count, say_to_user }` | Read-only. `open` is pending or approved. |
| `holdon_wait_for_decision` | `{ hold_id, timeout_seconds?: 1..50 }` (default 20) | `MemberHold & { waited_seconds, timed_out }` | Sends progress notifications when the call has a progress token. Card: hold. |
| `holdon_pay` | `{ hold_id?, check_id?, payment_method? }` (exactly one of `hold_id`, `check_id`) | `Receipt & { say_to_user }` | Simulated. Idempotent. Card: receipt. |
| `holdon_cancel_hold` | `{ hold_id }` | `MemberHold` | Card: hold. |

`next_step` from a check:

- `place_hold`: call `holdon_place_hold` with the `check_id`. This is also the answer for a stopped request, so that the family is told; such a hold has `blocked: true`.
- `pay`: confirmed payee, amount under the family's limit. Call `holdon_pay` with the `check_id`.
- `decline`: do not pay and do not place a hold (the circle has no trusted contact, or the family switched off notices for stopped requests).

`holdon_pay` error codes: `not_approved`, `denied`, `expired`, `cancelled`, `blocked`, `payee_not_verified`, `amount_required`, `method_required`, `method_not_allowed`, `not_found`, `invalid_input`.

### For the trusted contact's assistant (role `contact`)

| Tool | Input | Output | Notes |
| --- | --- | --- | --- |
| `holdon_family_inbox` | `{ status?: "pending" \| "all", limit?: 1..50 }` | `{ holds: FamilyHold[], count, say_to_user }` | Read-only. Card: approval. |
| `holdon_family_decide` | `{ hold_id, decision: "approve" \| "deny", note?, trust_payee? }` | `{ hold_id, status, decision: Decision, payee_status, trusted_payee_added, say_to_user }` | A stopped hold can only be denied (`blocked`). A payee outside the registry needs `trust_payee: true` (`payee_not_verified`). Card: approval. |
| `holdon_update_policy` | `{ approval_threshold_usd?: 0..10000, blocked_methods_official_payees?, blocked_methods_all_payees?, hold_expiry_hours?: 1..168, notify_on_stop?, remove_trusted_payee? }` (at least one) | `{ circle: Circle, changed: string[], say_to_user }` | |
| `holdon_get_circle` | `{}` | `{ circle: Circle }` | Read-only. |

The member cannot read the circle or the policy. The approval limit is never shown on the member's surface, so a caller cannot coach someone to stay under it.

## HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp`, `GET /mcp`, `DELETE /mcp` | MCP over Streamable HTTP. `Authorization: Bearer <token>` required. |
| `GET /events` | Server-Sent Events for the caller's circle. Bearer header, or `?access_token=` for browser `EventSource`. Supports `Last-Event-ID`. |
| `GET /approve/:holdId?t=<signed>` and `POST /approve/:holdId` | The family approval page. No script, works with a screen reader. |
| `GET /healthz`, `GET /` | Liveness and a short description. |

CORS is enabled for `localhost` origins (and any hostname in `HOLDON_ALLOWED_ORIGINS`), so a browser-based simulator can act as a real MCP client. `Mcp-Session-Id` is exposed to scripts.

### Events

```
event: ready
data: {"user":{"id":"user_sarah","name":"Sarah Ellis","role":"contact"},"circle_id":"circle_ellis","server_time":"..."}

id: 12
event: hold.created
data: {"id":12,"type":"hold.created","at":"...","circle_id":"circle_ellis","hold":{ ... }}
```

| Event | Sent to | `data` |
| --- | --- | --- |
| `ready` | everyone, once | `{ user: { id, name, role }, circle_id, server_time }` |
| `hold.created`, `hold.decided`, `hold.paid`, `hold.cancelled`, `hold.expired` | contact: every hold in the circle. member: their own holds | `{ id, type, at, circle_id, hold }` where `hold` is a `FamilyHold` for a contact and a `MemberHold` for a member |
| `policy.updated` | contact only | `{ id, type, at, circle_id, circle: Circle }` |

A member's stream never carries the approval link, the untrusted contact details or the family's limits. A comment line (`: keep-alive`) is sent every 15 seconds.

If `HOLDON_WEBHOOK_URL` is set, every event is also POSTed there as JSON in the contact's form, with `X-HoldOn-Event` and `X-HoldOn-Signature: sha256=<HMAC of the body>`.

## MCP features used

| Feature | Where |
| --- | --- |
| Streamable HTTP, protocol 2025-11-25 | `/mcp` with sessions (`Mcp-Session-Id`). `test/protocol.test.ts` sends a raw `initialize` and asserts the negotiated version. |
| Protocol 2026-07-28 | The same tool definitions served statelessly through `createMcpHandler`; requests are routed by `isLegacyRequest`. |
| Structured tool output | `outputSchema` and `structuredContent` on every tool. |
| Tool annotations, titles and icons | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`; SVG `icons` as data URIs. |
| Form elicitation | `holdon_check_request` asks one safety question when a key detail is missing and the client declares elicitation. Without it, the question is returned for the assistant to ask aloud (`clarification.status: "ask_user"`). |
| Progress notifications | `holdon_wait_for_decision`. |
| Tool execution errors for bad input | Validation failures come back with `isError: true` and an actionable message. |
| MCP Apps | `ui://holdon/hold-card.html`, `ui://holdon/receipt-card.html`, `ui://holdon/approval-card.html`, linked with `_meta.ui.resourceUri`. |

SDK: the v2 MCP TypeScript SDK (`@modelcontextprotocol/server`, `/node`, `/express`, and `/client` in tests) and `@modelcontextprotocol/ext-apps`.

### MCP Apps cards

Each card is one self-contained HTML file of a few kilobytes: no images, no network access, text written with `textContent` only. The older adult's cards contain no links at all. The trusted contact's approval card links only to the official pages cited in the rules and registry files, and opens them by asking the host (`ui/open-link`); what a caller supplied is shown as struck-through text, never as a link. The approval card's buttons call `holdon_family_decide` through the host, so the server applies the same rules as for any other caller. The cards speak the MCP Apps protocol directly (JSON-RPC over `postMessage`) instead of bundling an SDK; `test/apps.test.ts` loads them in jsdom and drives them with the official `AppBridge` host from `@modelcontextprotocol/ext-apps`, with tool calls forwarded to a real server.

The cards support light and dark: they follow `prefers-color-scheme`, and `hostContext.theme` when the host sends one (including a later change of it). The receipt card was checked on its own at 390x844 and on the simulator's kitchen display (a card area of about 897x455).

## Agent Skill

`skills/holdon-money-safety/SKILL.md` follows the open Agent Skills format. It tells an assistant when to call which tool, never to repeat a number or link from a suspicious message, how to phrase holds and denials, and what to do when someone is frightened or was told to keep a payment secret.

The assistant loads the skill; the server does not. The skill passes the reference validator (`skills-ref validate skills/holdon-money-safety`), and `test/docs.test.ts` checks that every tool it names is one the server offers. Whether a particular assistant follows it has to be checked on that assistant.

## Safety model

| Risk | What Hold On does |
| --- | --- |
| The assistant is talked into paying a scammer | Verdicts are rule-based. A stopped request cannot be approved by anyone or paid by any tool path. |
| A caller's phone number or link gets repeated to the older adult | The member's views are built without them and free text is redacted. Tests assert this for tool results, events and the hold card. |
| The older adult is coached to approve their own request | Deciding is a contact-only tool. The approval link is never returned to a member, and a link signed for a member does not open the page. |
| The older adult is coached to stay under the approval limit | The limit is not visible to the member. Unknown payees need approval at any amount. |
| A payment goes to details supplied by the caller | Hold On pays the registry's official record or a payee the contact vouched for by name. Details from the message are never used as a destination. |
| The trusted contact is pressured too | Gift cards and cryptocurrency to official payees stay blocked whatever the contact sets. Approving an unknown payee takes an explicit vouch. |
| Stale approval | A hold expires after `hold_expiry_hours`; an approval lapses if unused for the same window. Policy and registry are re-checked at pay time. |
| Wrong or outdated official facts | Every fact carries its source URL, a verbatim quote and the date read. `npm run verify:sources` re-checks them all. |
| Cross-family access | Every lookup is scoped to the caller's circle; another circle's hold is "not found". |

What it does not defend against is listed under Limitations.

## Data: registry and rules

- `registry/payees.json`: 11 payees. Each fact (official domain, phone number, mailing address, accepted method, method never used, contact practice) has `source_url`, a verbatim `quote` under 25 words, and `checked`. Facts were read on the organisation's own website on 2026-10-11. Anything that could not be fetched and confirmed was left out.
- `rules/scam-patterns.json`: 12 patterns. Each has a machine-checkable `when` condition (`all` / `any` / `not` over payment method, contact channel, urgency claims, a secrecy flag, payee category and word lists) and the official guidance behind it, sourced the same way.
- `rules/statistics.json`: the figures quoted in this README, sourced the same way.

```bash
npm run verify:sources            # re-fetch every page and check every quote (needs curl; pdftotext for the IC3 report)
npm run verify:sources -- --refresh
```

The verifier is separate from `npm test` because it needs the network and official sites sometimes refuse automated requests. On 2026-10-11 it confirmed all 117 sourced facts against 37 pages.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `HOLDON_HOST` | `127.0.0.1` | Bind address. Localhost binds get DNS-rebinding and Origin protection from the MCP SDK. |
| `HOLDON_PUBLIC_URL` | local address | Base URL used in approval links |
| `HOLDON_ALLOWED_HOSTS` | | Extra `Host` names to accept (comma separated) |
| `HOLDON_ALLOWED_ORIGINS` | | Extra browser origin hostnames to accept |
| `HOLDON_DB` | `data/holdon.db` | SQLite file |
| `HOLDON_SECRET` | generated | Signs approval links and webhooks. If unset, a random key is created once in `data/secret.key`. |
| `HOLDON_WEBHOOK_URL` | | Receives every hold event |
| `HOLDON_LOG_APPROVAL_LINKS` | `1` | Print each new hold's signed approval link to the log. Set to `0` anywhere logs are shared. |
| `HOLDON_SEED_FILE` | `seed/demo-circle.json` | Circle to create with `npm run seed` |

See `.env.example`. Nothing secret is stored in the repository; `data/` is git-ignored.

**Authentication.** For the demo, bearer tokens map to people and roles through the seed file, and only their SHA-256 hashes are stored. A production deployment would use OAuth 2.1 as described in the MCP authorization specification: protected resource metadata, an authorization server, audience-bound access tokens, and role as a scope or claim.

## Testing

```bash
npm test          # vitest
npm run typecheck
```

| File | Covers |
| --- | --- |
| `test/engine.test.ts`, `test/rules.test.ts` | Rule engine: each pattern with an example and a counter-example, verdict rules, determinism, everyday requests that must not be flagged, wording |
| `test/registry.test.ts` | Registry schema: every fact has `source_url`, `quote`, `checked`; quotes under 25 words; sources on the organisation's own site; matching |
| `test/protocol.test.ts` | Raw JSON-RPC: `initialize` with `protocolVersion: "2025-11-25"`, sessions, auth, CORS, 2026-07-28 |
| `test/e2e.test.ts` | Real MCP client over Streamable HTTP: the scenarios above, pay before approval, role enforcement, cross-session state, progress, elicitation, validation errors |
| `test/service.test.ts` | State machine, expiry, pay-time re-checks, policy floor, isolation between circles, approval link signatures |
| `test/http.test.ts` | Event stream per role with replay, approval page, webhook |
| `test/apps.test.ts` | MCP Apps cards driven by the official host bridge |
| `scripts/screenshots.mjs` | Not part of `npm test`: real Chrome at 390x844, the first-screen rule, light and dark, the receipt card at phone and kitchen-display sizes, and mouse presses on Approve, Deny and a source link |

## Limitations

- **Simulated payments only.** There is no payment rail. In a real deployment, payment would be the host platform's own purchasing capability, with Hold On as the gate.
- **A small registry.** Eleven payees, checked on one date. Phone numbers and policies change; the `checked` date is on every fact for that reason. Regional utilities are represented by six large ones. Duke Energy has no phone number on file because its main site refused automated requests.
- **Word lists are blunt.** The patterns match fixed English phrases and structured fields. They miss paraphrases and other languages, and can flag an ordinary request (anything involving cryptocurrency is stopped, for example). The structured fields (`payment_method`, `contact_channel`, `secrecy_requested`, `urgency_claims`) are more reliable than the description text, and they depend on the assistant filling them in honestly.
- **A name match is a claim, not proof.** "Con Edison" by name resolves to the official record so that money can only go to the real payee. It does not prove that the caller was Con Edison.
- **One trusted contact decides.** Notifications go to the event stream, the inbox tool, the server log and an optional webhook. There is no SMS, email or push delivery, and no second approver.
- **Demo authentication.** Static bearer tokens, no OAuth, no rate limiting, no audit export. Sessions for 2025-era clients are kept in memory in one process.
- **The 2026-07-28 path** is covered by fewer tests than the 2025-11-25 path.
- **The MCP Apps cards** were exercised in jsdom against the official host bridge and in headless Chrome inside a Voicestage phone frame, not in a production assistant host. The first-screen layout was measured at 390x844 and in that frame (about 397x614); a much smaller card area would push the buttons to a bar that sticks to the bottom edge.
- **Not legal or financial advice**, and not a substitute for reporting fraud to the FTC, a bank or the police.

## Sources

Read on 2026-10-11. Quotes and dates are in the data files.

**Scam guidance and statistics (`rules/scam-patterns.json`, `rules/statistics.json`)**

- Consumer Financial Protection Bureau: [Protecting against fraud: resources for older adults](https://www.consumerfinance.gov/consumer-tools/educator-tools/resources-for-older-adults/protecting-against-fraud/)
- Consumer Financial Protection Bureau: [What are some classic warning signs of possible fraud and scams?](https://www.consumerfinance.gov/ask-cfpb/what-are-some-classic-warning-signs-of-possible-fraud-and-scams-en-2094/)
- Duke Energy: [10th annual Utility Scam Awareness Day](https://news.duke-energy.com/releases/10th-annual-utility-scam-awareness-day-putting-customers-first-in-the-fight-against-scams)
- FBI Internet Crime Complaint Center: [2025 IC3 Annual Report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf)
- Federal Trade Commission: [Avoiding and Reporting Gift Card Scams](https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams)
- Federal Trade Commission: [Fake Prize, Sweepstakes, and Lottery Scams](https://consumer.ftc.gov/articles/fake-prize-sweepstakes-and-lottery-scams)
- Federal Trade Commission: [How To Avoid a Government Impersonation Scam](https://consumer.ftc.gov/articles/how-avoid-government-impersonation-scam)
- Federal Trade Commission: [How To Avoid a Scam](https://consumer.ftc.gov/articles/how-avoid-scam)
- Federal Trade Commission: [How To Spot, Avoid, and Report Fake Check Scams](https://consumer.ftc.gov/articles/how-spot-avoid-and-report-fake-check-scams)
- Federal Trade Commission: [How To Spot, Avoid, and Report Tech Support Scams](https://consumer.ftc.gov/articles/how-spot-avoid-and-report-tech-support-scams)
- Federal Trade Commission: [Scammers Pretend To Be Your Utility Company](https://consumer.ftc.gov/articles/scammers-pretend-be-your-utility-company)
- Federal Trade Commission: [Scammers Use Fake Emergencies To Steal Your Money](https://consumer.ftc.gov/articles/scammers-use-fake-emergencies-steal-your-money)
- Federal Trade Commission: [What To Know About Cryptocurrency and Scams](https://consumer.ftc.gov/articles/what-know-about-cryptocurrency-and-scams)
- Internal Revenue Service: [How to know it's the IRS](https://www.irs.gov/help/how-to-know-its-the-irs)
- Internal Revenue Service: [Taxpayers shouldn't let gift card scammers ruin the holidays](https://www.irs.gov/newsroom/taxpayers-shouldnt-let-gift-card-scammers-ruin-the-holidays)
- Medicare.gov: [Your Medicare card](https://www.medicare.gov/basics/get-started-with-medicare/using-medicare/your-medicare-card)
- Social Security Administration: [Protect Yourself from Scams](https://www.ssa.gov/scam/)
- Social Security Administration: [What should I do if I receive a call from someone claiming to be a Social Security employee?](https://www.ssa.gov/faqs/en/questions/KA-10018.html)

**Payee facts (`registry/payees.json`)**

- Internal Revenue Service: <https://www.irs.gov/help/tax-scams/recognize-tax-scams-and-fraud>, <https://www.irs.gov/help/let-us-help-you>, <https://www.irs.gov/payments>, <https://www.irs.gov/payments/pay-by-check-or-money-order>, <https://www.irs.gov/newsroom/taxpayers-shouldnt-let-gift-card-scammers-ruin-the-holidays>, <https://www.irs.gov/help/how-to-know-its-the-irs>
- Social Security Administration: <https://www.ssa.gov/agency/contact/>, <https://www.ssa.gov/agency/contact/phone.html>, <https://www.ssa.gov/faqs/en/questions/KA-10018.html>, <https://www.ssa.gov/scam/>
- Medicare: <https://www.medicare.gov/basics/reporting-medicare-fraud-and-abuse>, <https://www.medicare.gov/basics/costs/pay-premiums>, <https://www.medicare.gov/basics/get-started-with-medicare/using-medicare/your-medicare-card>
- United States Postal Service: <https://www.uspis.gov/news/scam-article/smishing-package-tracking-text-scams>, <https://www.usps.com/help/contact-us.htm>
- Federal Trade Commission: <https://consumer.ftc.gov/articles/how-avoid-government-impersonation-scam>
- Con Edison: <https://www.coned.com/en/safety/energy-safety/beware-of-scammers>, <https://www.coned.com/en/accounts-billing/payment-options>
- Pacific Gas and Electric Company: <https://www.pge.com/en/account/customer-service/scams.html>, <https://www.pge.com/en/account/billing-and-assistance/pay-my-bill.html>
- Florida Power & Light: <https://www.fpl.com/landing/protect.html>, <https://www.fpl.com/account/bill/ways-to-pay.html>, <https://newsroom.fpl.com/Beware-of-Scammers-FPL-Uncovers-New-Tactic-Targeting-Customers-Internet-Searches-for-FPL>
- Dominion Energy: <https://www.dominionenergy.com/scams>
- National Grid: <https://www.nationalgridus.com/Our-Company/Scam-Alert>
- Duke Energy: <https://news.duke-energy.com/releases/10th-annual-utility-scam-awareness-day-putting-customers-first-in-the-fight-against-scams>

## Hackathon notes

- [docs/hackathon/friction-log.md](docs/hackathon/friction-log.md): what got in the way while building this, with error text and versions.
- [docs/hackathon/product-feedback.md](docs/hackathon/product-feedback.md): feedback on the MCP specification, the TypeScript SDK, MCP Apps and Agent Skills, and feature requests.

No Alexa+ developer tooling was available to hackathon participants. Hold On has been run against the MCP SDK's client, the MCP Apps host bridge and a browser-based simulator, never against an Alexa+ device or runtime.

## License

MIT. See [LICENSE](LICENSE).
