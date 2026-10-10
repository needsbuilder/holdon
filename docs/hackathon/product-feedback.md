# Product feedback: what we built Hold On with

Hold On is a self-hosted MCP server with an Agent Skill and three MCP Apps cards, built for the Alexa+ track. This document covers each tool, SDK and specification we actually used, in the order we met them. The incidents behind the criticisms are written up one by one, with error text, in [friction-log.md](friction-log.md); entries are cited here as F-01 to F-14.

**Scope, stated plainly.** No Alexa+ developer tooling was available to hackathon participants. We did not use the Category SDK, the MCP Toolkit, the CLI or the Web Simulator, and Hold On has never been connected to an Alexa+ device or runtime. Everything below is about the open MCP stack, and was observed against the MCP SDK's own client, the MCP Apps host bridge, and a simulator of our own. Nothing here is a claim about how Alexa+ behaves.

Versions: `@modelcontextprotocol/server` 2.3.1, `/node` 2.1.1, `/express` 2.0.2, `/client` 2.3.1, `@modelcontextprotocol/ext-apps` 2.0.3, Node.js 24.16.0.

## 1. MCP specification, revision 2025-11-25 (and 2026-07-28)

**What we used it for.** The whole product surface: twelve tools over Streamable HTTP with bearer tokens, split by role (the older adult's assistant and the trusted family contact's assistant see different tool lists). From 2025-11-25 specifically: `outputSchema` with `structuredContent`, tool annotations, tool `icons`, form elicitation for one clarifying safety question, and progress notifications while waiting for a family member. The same tool definitions are also served on 2026-07-28.

**What worked well.**
- Structured output with a declared schema gave the cards, the tests and the README one contract to work from.
- Input validation errors returned as tool results (`isError: true`) rather than protocol errors mean a model can read "amount_usd must be greater than zero." and try again.
- Form elicitation with a fixed list of answers is the right size for a voice product: one question, a handful of choices, nothing free-form.
- Annotations let us say which tools only read, and mark the payment tool as the one destructive action.

**What needs work.**
- The two revisions ask the user for input in different ways: a server-to-client request in 2025-11-25, an `input_required` result in 2026-07-28. A server that wants to work with both has to care about transport details (sessions) that the newer revision removes (F-01).
- A tool cannot say how long it may run, and whether progress keeps a call alive is the client's choice (F-06). Waiting for another person is a natural thing for a household assistant to do, and today the server has to guess a safe duration.
- There is no standard way to say that one tool result should be announced on another person's device. Our "tell the trusted contact" step is our own event stream and web page. For a household product that is the central interaction.
- Different tools for different people on one server works, but only through whatever the HTTP layer does with tokens. We could not find guidance on household roles.

**Zero to a first working call.** A raw `initialize` with `protocolVersion: "2025-11-25"`, sent as plain HTTP with no SDK on the client side, was answered correctly by the first spike we wrote. That request is now in `test/protocol.test.ts` and in the README as a `curl` command.

**Would we build with it again?** Yes. The protocol gave a small project a typed, testable, role-aware surface, and the same server answered three kinds of caller without changes: raw HTTP requests, the SDK's client, and a browser page acting as an MCP client.

## 2. MCP TypeScript SDK v2 (`server`, `node`, `express`, `client`)

**What we used it for.** `McpServer.registerTool` with zod schemas; `createMcpHandler` for 2026-07-28; `NodeStreamableHTTPServerTransport` with sessions for 2025-11-25; `isLegacyRequest` to route between them; `inputRequired` / `inputResponse` for elicitation; `createMcpExpressApp` for the HTTP app; the client package for every end-to-end test.

**What worked well.**
- **Write-once handlers.** A tool that returns `inputRequired(...)` is served to 2026-07-28 clients natively and to 2025-11-25 clients through a shim that sends a real `elicitation/create`. One handler, two revisions, and our tests run both.
- **Per-request factory with `authInfo`.** Building a server per principal made role-based tool lists one `if` statement: a tool that is not registered for your role is not there to call.
- **Error messages.** The one in F-01 says exactly what is wrong and why. Validation errors name the tool and the field.
- **The type definitions.** The comments in `dist/*.d.mts` are the best documentation we found. `isLegacyRequest` in particular explains every case it classifies.
- **The client.** `authProvider: { token: async () => ... }` and `versionNegotiation: { mode }` were all the configuration our tests needed.

**What needs work.**
- The default HTTP entry point serves the hackathon's minimum revision without sessions, which removes elicitation for it (F-01). We had to write the sessionful path ourselves.
- The package READMEs are a few hundred words each and do not say which revisions are served or what the stateless fallback cannot do (F-05).
- Two of the SDK's own pieces fail when composed the obvious way, with an error that blames the JSON (F-04).
- `createMcpExpressApp()` guards every route on the app, including ones that are not MCP. Together with a mistake of ours, that silently broke a browser form (F-02).
- The client passes its own progress text to the caller's `onprogress` (F-09), and does not reset its timeout on progress unless asked (F-06).
- A small surprise rather than a problem: we declared `capabilities: { tools: {}, resources: {} }` and the `initialize` response advertises `"listChanged": true` for both. Our lists never change.

**Zero to a first working call.** `npm install`, then one spike file with a server and a client. On its first run it negotiated 2025-11-25 from a raw request, listed a tool with its icon and output schema, ran an elicitation and delivered three progress notifications, in both revisions. Getting there took reading type definitions rather than a guide, because the README headline ("implementing the 2026-07-28 MCP spec") made us unsure the older revision was still supported at all.

**Would we build with it again?** Yes. The two-revision design is the reason one small codebase satisfies "2025-11-25 or later" without a fork. The part we would rather not write again is the session handling for 2025-era clients (F-01).

## 3. MCP Apps (`@modelcontextprotocol/ext-apps`, specification 2026-01-26)

**What we used it for.** Three `ui://` cards linked from tools with `registerAppTool` and `registerAppResource`: a hold card and a receipt for the older adult, and an approval card for the family contact whose Approve and Deny buttons call a tool through the host. `AppBridge` is the host in our tests.

**What worked well.**
- **The security model fits a safety product.** A card can only act by asking the host, so our approval card cannot approve anything the server would refuse to any other caller. Our cards request no network domains and load nothing.
- **`ui/open-link`.** It gave us a way to cite official sources from inside a sandboxed card without the card ever navigating, and the host stays in charge of whether a link opens.
- **`hostContext.theme` and `setHostContext`.** Following the host's light or dark choice took a few lines.
- **`registerAppTool`** fills in the older `_meta["ui/resourceUri"]` key by itself.
- **`AppBridge` runs headless.** With a custom transport it drove our cards in tests, with tool calls forwarded to a real server.

**What needs work.**
- The view-side `App` class brings about 590 kB into each card when bundled (F-03). We wrote the view side by hand instead.
- `registerAppTool`'s config type has no `icons`, and the compiler error points elsewhere (F-07).
- There is no documented way to test a view. The official `PostMessageTransport` cannot run in jsdom (F-08).
- We found no guidance for small screens or for voice-first hosts: how tall a card may be, whether the host scrolls, what a speaker with no screen does with a tool that has a card. We sized ours by measuring our own simulator.
- A detail: `require('@modelcontextprotocol/ext-apps/package.json')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, so a script cannot read the installed version the usual way.

**Zero to a first working call.** The server side worked immediately: two helper calls and the tool listed its card. The view side took a detour. The first build with the official `App` class produced 593 kB files; the hand-written replacement passed the `AppBridge`-driven tests on its first run.

**Would we build with it again?** Yes, for anything where a person must look before they act. We would again write the view by hand unless a small client ships.

## 4. Agent Skills (open format, agentskills.io specification)

**What we used it for.** `skills/holdon-money-safety/SKILL.md`: when to call which Hold On tool, never to repeat a phone number or link from a suspicious message, how to phrase a hold or a denial, and what to do when someone is frightened or was told to keep a payment secret.

**What worked well.**
- The format is small enough to get right the first time. The reference validator accepted the skill unchanged: `Valid skill: skills/holdon-money-safety`.
- A skill is the right place for behaviour that a tool schema cannot carry. "Do not say the caller's number back" is not something a JSON Schema can express.
- Progressive disclosure (a short description, then the body) matches how a voice assistant should load safety instructions: only when money comes up.

**What needs work.**
- A skill cannot declare the MCP tools it needs (F-12). A host could install ours without the server and nothing would say so.
- The specification names the validator but not how to run it (F-11).

**What we could not check.** Whether an assistant follows the skill. We validated its format and that every tool it names exists. Its effect on a real assistant's behaviour, on Alexa+ or anywhere else, is untested by us.

**Would we build with it again?** Yes. For a product whose rules are mostly about what not to say, instructions that travel with the tools are worth more than another tool.

## 5. Alexa+ developer tooling and the hackathon's guidance

**What we used.** Only the hackathon's Official Rules, FAQ and resources page. None of the Alexa+ add-on tools, because participants could not get them. The Amazon Devices Builder Tools on the resources page target Fire OS and Vega, not this track, and we did not use them.

**What worked well.**
- The FAQ is direct about the situation, and about what counts: a web page acting as a real MCP client, sending `initialize`, `tools/list` and `tools/call` over Streamable HTTP, satisfies the requirement. That sentence let us plan.
- Requiring an open protocol means the work is portable. Hold On runs against any MCP client today.

**What needs work.**
- Without the runtime, every question about the target experience stayed open (F-14): which revision the client speaks, whether it elicits, how it shows a card, how two people in a household are told apart.
- "2025-11-25 (or a later version, once confirmed)" does not say which revision to aim for (F-13).

**Would we build for it again?** Yes, if there is a way to try the result on the real thing. The product idea depends on things only the platform can answer: a second person's device speaking up, and a purchase that waits for them.

## Feature requests

| Priority | Request | For | Why it mattered here |
| --- | --- | --- | --- |
| Critical | Publish what the Alexa+ MCP client sends and supports: a recorded `initialize`, its capabilities, how elicitation and cards are presented; or a public simulator | Alexa+ | Nothing about the target experience could be tested (F-14) |
| Critical | A sessionful 2025-era option in `createMcpHandler` | MCP TypeScript SDK | The track's minimum revision loses elicitation under the default (F-01) |
| Important | A way for a tool result to notify another member of the household, with their consent | MCP specification / Alexa+ | "Ask the trusted contact" is the core of the product and is entirely our own plumbing |
| Important | Guidance, or a capability, for household roles: one add-on, several people, different tools | MCP specification / Alexa+ | Role separation is our main safety property |
| Important | A small dependency-free view client for MCP Apps | MCP Apps | 590 kB per card otherwise (F-03) |
| Important | A test harness for MCP Apps views | MCP Apps | No documented way to test a card (F-08) |
| Important | A structured way for a skill to require MCP tools | Agent Skills | A skill and its server can be installed apart (F-12) |
| Important | Let a tool declare its expected duration, or reset client timeouts on progress by default | MCP specification / SDK | Waiting for a person had to be capped by guesswork (F-06) |
| Nice-to-have | A version and feature table in the SDK README | MCP TypeScript SDK | F-05 |
| Nice-to-have | Scope the Express Host and Origin guards to the MCP path, or document that they cover the whole app | MCP TypeScript SDK | F-02 |
| Nice-to-have | Use `req.body` in `toNodeHandler` when the stream was already read, or say so in the error | MCP TypeScript SDK | F-04 |
| Nice-to-have | `icons` in `registerAppTool`'s config type | MCP Apps | F-07 |
| Nice-to-have | Mark or suppress SDK-generated progress messages | MCP TypeScript SDK | F-09 |
| Nice-to-have | A copy-and-paste command for the Agent Skills validator | Agent Skills | F-11 |
| Nice-to-have | Card sizing guidance for small and voice-first hosts | MCP Apps | We sized cards by measuring our own simulator |
