# Friction log: building Hold On

Hold On is a self-hosted MCP server with an Agent Skill and MCP Apps cards, built for the Alexa+ track. This log records the friction we actually ran into while building it. The entries are of three kinds, and each one says which:

- **Hit.** Something failed in front of us while building or testing (F-02, F-03, F-04, F-09, F-10).
- **Designed around.** We read about the limit in the SDK's type definitions or source before writing the code and built the workaround first. The cost was the workaround, not a debugging session. To record what a developer who had not read that far would see, we ran the failing version afterwards (F-01, F-06, F-07, F-08).
- **Gap.** Something the documentation or the hackathon guidance did not tell us (F-05, F-11, F-12, F-13, F-14).

All error text is copied from a terminal. The reproductions were run on 2026-10-11 with the versions below.

**What this log is not.** No Alexa+ developer tooling was available to hackathon participants (see F-14). Hold On was only ever run against our own simulator and the MCP SDK's own client. Nothing here is a statement about how the real Alexa+ runtime behaves.

## Environment

| | |
| --- | --- |
| Node.js | 24.16.0 (macOS, arm64) |
| `@modelcontextprotocol/server` | 2.3.1 |
| `@modelcontextprotocol/node` | 2.1.1 |
| `@modelcontextprotocol/express` | 2.0.2 |
| `@modelcontextprotocol/client` | 2.3.1 |
| `@modelcontextprotocol/ext-apps` | 2.0.3 (MCP Apps specification 2026-01-26) |
| Other | express 5.3.0, zod 4.6.5, TypeScript 7.0.2, esbuild 0.28.2, jsdom 30.1.2, puppeteer-core 25.13.0, Chrome 154.0.8037.98 |
| Agent Skills validator | `skills-ref` from `agentskills/agentskills` at commit `69ef37e` |

## Summary

| ID | Kind | Area | Severity | What happened |
| --- | --- | --- | --- | --- |
| F-01 | Designed around | MCP TypeScript SDK | Major | The default HTTP handler serves 2025-11-25 clients statelessly, so elicitation cannot work on the track's minimum protocol version |
| F-02 | Hit | MCP TypeScript SDK (Express) + our code | Major | The approval form was refused with `Invalid Origin header: null`; Approve and Deny did nothing in a real browser |
| F-03 | Hit | MCP Apps | Major | Bundling the `App` class made each small card about 590 kB |
| F-04 | Hit | MCP TypeScript SDK | Minor | Two SDK pieces mounted together the obvious way fail with `Parse error: Invalid JSON` |
| F-05 | Gap | MCP TypeScript SDK docs | Minor | The README says v2 implements 2026-07-28; whether 2025-11-25 is still served had to be found in `dist` |
| F-06 | Designed around | MCP TypeScript SDK (client) | Minor | Progress notifications do not keep a call alive unless the caller opts in |
| F-07 | Designed around | MCP Apps | Minor | `registerAppTool` rejects `icons` at compile time, with an error about something else |
| F-08 | Designed around | MCP Apps testing | Minor | The official `PostMessageTransport` cannot drive a card in jsdom |
| F-09 | Hit | MCP TypeScript SDK (client) | Minor | SDK-written progress text reaches the caller's `onprogress` |
| F-10 | Hit | MCP Apps testing | Minor | Mouse automation misses buttons in a card whose host scales the iframe with CSS `zoom` |
| F-11 | Gap | Agent Skills | Minor | The validator exists, but the specification does not say how to get the command |
| F-12 | Gap | Agent Skills | Minor | A skill cannot declare the MCP tools it depends on |
| F-13 | Gap | Hackathon guidance | Minor | "2025-11-25 or a later version, once confirmed" left the target revision open |
| F-14 | Gap | Alexa+ | Blocker for testing on the target platform | No Alexa+ developer tooling was available, so nothing could be checked against the real runtime |

---

## F-01. The default HTTP handler cannot elicit from 2025-11-25 clients

**Severity:** Major. The track's minimum protocol version loses server-to-client requests under the SDK's default entry point.

**Task attempted.** Serve one MCP server over Streamable HTTP that negotiates 2025-11-25 and asks the user one safety question by form elicitation when a key detail is missing.

**How we met it.** Designed around. Before writing server code we read the type documentation for `createMcpHandler`, which says its own serving of 2025-era traffic is "selected by the `'stateless' | 'reject'` posture only", and we wired sessions for that traffic from the first spike. The run below is what the default does; we did it afterwards to confirm that the extra wiring was needed.

**Steps taken.**
1. `createMcpHandler(factory)` with default options, wrapped with `toNodeHandler`, mounted on `createMcpExpressApp()`.
2. A tool that returns `inputRequired({ inputRequests: { q: inputRequired.elicit({ message, requestedSchema }) } })` on its first run.
3. A client with `capabilities: { elicitation: { form: {} } }` and default negotiation, which negotiates 2025-11-25.

**Expected.** The SDK's legacy shim sends `elicitation/create` to the client and re-enters the handler. The type documentation says handlers are "written once and serve both eras".

**Actual.** The tool call returns a tool error:

```
Cannot request input 'q' (elicitation/create): the client on this 2025-era connection did not declare the required capability (no client capabilities are available on this connection — per-request legacy serving cannot receive server-to-client requests)
```

On the same connection `server.server.getClientCapabilities()` reports no elicitation capability, although the client declared it in `initialize`. The identical handler works when the client negotiates 2026-07-28 (`versionNegotiation: { mode: 'auto' }`).

**Workaround.** Route by era ourselves (`src/http/app.ts`): `isLegacyRequest()` sends 2025-era traffic to one `NodeStreamableHTTPServerTransport` per `Mcp-Session-Id`, and everything else to `createMcpHandler(factory, { legacy: 'reject' })`. That meant writing the session map, the idle sweep, the "start with initialize" and "unknown session" answers, and a check that a session is only used by the token that opened it.

**Suggestion.** Offer the sessionful 2025 path as an option of `createMcpHandler` (for example `legacy: 'sessions'`), or export a ready-made sessionful fallback next to `legacyStatelessFallback`. Say in the package README which features the stateless fallback cannot provide (elicitation, sampling, roots). The error message itself is clear and should stay as it is.

---

## F-02. The approval form was refused with `Invalid Origin header: null`

**Severity:** Major. The human approval step did nothing in a real browser, and our integration tests did not notice.

This one is half our own bug. It is logged because of how the SDK's guard made it invisible.

**Task attempted.** Serve a plain HTML page with an Approve / Deny form from the same Express app as the MCP endpoint, so a family member can decide with nothing but a browser.

**Steps taken.**
1. `createMcpExpressApp()` (default host `127.0.0.1`), plus our own `GET` and `POST /approve/:holdId` routes.
2. To keep the signed link out of `Referer` headers, we sent `Referrer-Policy: no-referrer` with the page.
3. Opened the page in headless Chrome 154 and pressed Approve.

**Expected.** The form post reaches our route and the hold is approved.

**Actual.** HTTP 403, and the hold stayed pending:

```
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Origin header: null"},"id":null}
```

Under `no-referrer`, Chrome submits the form with `Origin: null` (we confirmed this separately: the same form on a `same-origin` page sends its real origin). The Origin check that `createMcpExpressApp()` installs applies to every route on the app, not only to the MCP endpoint, and it answers our HTML route with a JSON-RPC body. Our tests posted the form with `fetch` and no `Origin` header, which the check lets through, so they passed.

**Workaround.** `Referrer-Policy: same-origin` (a same-origin form post then carries its real origin, and no `Referer` leaves the server). A regression test now posts with an `Origin` header, and `scripts/screenshots.mjs` presses the button in real Chrome.

**Suggestion.** State in the `@modelcontextprotocol/express` README that the Host and Origin guards cover every route added to the app, and list the ordinary cases that produce `Origin: null`: forms on `no-referrer` pages, sandboxed iframes (which is where MCP Apps cards live), and `file://` pages. Consider an option to scope the guards to the MCP path.

---

## F-03. Bundling the MCP Apps `App` class made each card about 590 kB

**Severity:** Major for small cards. It pushed us to re-implement the view side of the protocol.

**Task attempted.** Three small `ui://` cards (a hold status, a receipt, an approval card), each a single self-contained HTML file with no network access.

**Steps taken.** Each view imported `App` from `@modelcontextprotocol/ext-apps` and was bundled with esbuild (`format: 'iife'`, `minify: true`) into one inline script.

**Expected.** A card that shows six lines of text is a few kilobytes.

**Actual.** Build output:

```
built dist/ui/hold-card.html (593 kB)
built dist/ui/approval-card.html (597 kB)
built dist/ui/receipt-card.html (592 kB)
```

The package's prebuilt `dist/src/app-with-deps.js` is 418,465 bytes on its own.

**Workaround.** We wrote the few messages a card needs by hand (`ui/shared.js`, about 80 lines: `ui/initialize`, `ui/notifications/initialized`, `ui/notifications/tool-result`, `tools/call`, `ui/open-link`, `ui/notifications/size-changed`, `ui/notifications/host-context-changed`, `ui/resource-teardown`). The cards are now 10 to 18 kB. To keep that honest, `test/apps.test.ts` drives every card with the official `AppBridge`.

**Suggestion.** Ship a dependency-free "lite" view client without schema validation, or document the minimal wire messages as a supported way to write a view.

---

## F-04. `toNodeHandler(createMcpHandler(...))` on `createMcpExpressApp()` fails with "Parse error: Invalid JSON"

**Severity:** Minor. It is a one-line fix once understood, but both error messages point the wrong way.

We hit this while writing a minimal reproduction for F-01; the project code already passed the body explicitly.

**Steps taken.**

```js
const app = createMcpExpressApp();
app.all('/mcp', toNodeHandler(createMcpHandler(factory)));
```

then connected a client.

**Expected.** It works, since all three functions come from the SDK, or it fails with an error that mentions the body parser.

**Actual.** The client throws:

```
SdkHttpError: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: Invalid JSON"},"id":null}
  code: 'CLIENT_HTTP_NOT_IMPLEMENTED',
  data: { status: 400, statusText: 'Bad Request', ... }
```

`createMcpExpressApp()` installs `express.json()`, which has already read the body. Express passes `next` as the third argument, which `toNodeHandler` ignores by design, so the handler reads an empty stream and reports invalid JSON. The JSON the client sent was valid. The client-side code `CLIENT_HTTP_NOT_IMPLEMENTED` for an HTTP 400 is a second false lead.

**Workaround.** `app.all('/mcp', (req, res) => handler(req, res, req.body))`.

**Suggestion.** When the stream is already consumed and `req.body` is set, use it, or fail with "the request body was already read; pass `req.body` as the third argument". Give HTTP 4xx answers their own client error code.

---

## F-05. Which protocol versions does v2 serve? The README does not say

**Severity:** Minor.

**Task attempted.** Decide between the v1 and v2 SDK. The track requires 2025-11-25 as a minimum, and the v2 README opens with "This is v2 of the MCP TypeScript SDK ... implementing the 2026-07-28 MCP spec".

**Steps taken.** Read the installed READMEs (the server README is 1,900 bytes, the client README 1,326 bytes). Neither says whether 2025-11-25 is still served. Printed the exported constants:

```
SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
LATEST_PROTOCOL_VERSION = '2025-11-25'
DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26'
```

then read the type definitions and wrote a spike that sent a raw `initialize`.

**Expected.** A table in the README: which revisions each entry point serves, and with which features.

**Actual.** The answer is in `dist/*.d.mts`. The comments there are thorough (the file for `createMcpHandler` is 4,167 lines), but they are not where a newcomer looks. `LATEST_PROTOCOL_VERSION` being `2025-11-25` in an SDK that implements 2026-07-28 is confusing until one learns that it means "latest version negotiated by `initialize`".

**Workaround.** The spike, kept as `test/protocol.test.ts`.

**Suggestion.** A version and feature table in the README. Rename `LATEST_PROTOCOL_VERSION`, or document what it means now.

---

## F-06. Progress does not keep a call alive unless the caller opts in

**Severity:** Minor.

**Task attempted.** `holdon_wait_for_decision`: wait for a family member's answer and send progress while waiting.

**How we met it.** Designed around. The client's type definitions list `resetTimeoutOnProgress` as an option, so we assumed progress would not keep a call alive by default and capped the wait before the tool was written. The run below confirms the default.

**Steps taken.** A tool that sends `notifications/progress` every 100 ms for 3 s; `client.callTool(..., { timeout: 1000, onprogress })`.

**Expected.** As long as progress arrives, the call is not timed out.

**Actual.**

```
SdkError: Request timed out   (code REQUEST_TIMEOUT)   after 1004 ms, 9 progress notifications received
```

With `resetTimeoutOnProgress: true` the same call completes after 3071 ms. The default timeout (`DEFAULT_REQUEST_TIMEOUT_MSEC`) is 60000.

**Why it mattered.** A server cannot know which option its client uses. We capped the wait at 50 seconds and tell the assistant to call again.

**Suggestion.** Reset the timeout on progress by default when `onprogress` is given, or let a tool advertise how long it may run.

---

## F-07. `registerAppTool` rejects `icons`, and the compiler blames the schema

**Severity:** Minor.

**Task attempted.** Give the tools that have a card the same icons as the tools that do not.

**How we met it.** Designed around. We saw in the type definitions that `ToolConfig` has no `icons` and wrote the helper below first. Afterwards we compiled the direct form to see what the compiler says to someone who has not read the types.

**Steps taken.**

```ts
registerAppTool(server, 'with-card', { inputSchema: z.object({}), icons, _meta: { ui: { resourceUri: 'ui://x/card.html' } } }, cb);
```

**Expected.** It compiles: `server.registerTool` accepts `icons`, and `registerAppTool` passes the whole config through at run time.

**Actual.**

```
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'ZodObject<{}, $strip>' is not assignable to type 'ZodRawShape | (StandardSchemaWithJSON<unknown, unknown> & ZodRawShape) | undefined'.
      ...
          Index signature for type 'string' is missing in type 'ZodObject<{}, $strip>'.
```

The real cause is that `ToolConfig` in `ext-apps` has no `icons` field, so the first overload fails on an excess property; TypeScript then reports the deprecated raw-shape overload instead. Removing `icons` compiles. Passing the same object through a variable also compiles, and the icons do reach `tools/list`.

**Workaround.** A helper, `withCard(config, uri)` in `src/mcp/apps.ts`, so the config is never an object literal at the call site.

**Suggestion.** Add `icons` to `ToolConfig`, or derive that type from the server's own `registerTool` config.

---

## F-08. The official `PostMessageTransport` cannot drive a card in jsdom

**Severity:** Minor. The gap is jsdom's, but there is no documented way to test a view.

**Task attempted.** Test the cards in Node against the official host implementation, without a browser.

**How we met it.** Designed around. The transport's documentation says it validates `event.source`, and jsdom's source has a TODO where that property would be set, so our tests used a custom transport from the start. The run below confirms it.

**Steps taken.** Loaded a built card in jsdom and connected the official host: `bridge.connect(new PostMessageTransport(window, window))`.

**Expected.** The handshake completes and `oninitialized` fires.

**Actual.** The console shows

```
Ignoring message from unknown source MessageEvent { isTrusted: [Getter] }
```

and `oninitialized` never fires. The card's `ui/initialize` does arrive, but with `event.source === null`: jsdom's `window.postMessage` does not set it (`// TODO: event.source` in `jsdom/lib/jsdom/browser/Window.js`), and the transport rightly drops messages from an unknown source.

**Workaround.** A small custom `Transport` in `test/apps.test.ts`. `AppBridge` works with it, so the cards are still tested against the official host logic, with tool calls forwarded to a real server.

**Suggestion.** Ship a test harness with `ext-apps`: an in-memory transport pair for `App` and `AppBridge`, and a short "testing your view" page.

---

## F-09. SDK-written progress text reaches the caller's `onprogress`

**Severity:** Minor.

**How we met it.** Hit. It was in the output of our first spike.

**Steps taken.** A 2026-07-28 client (`versionNegotiation: { mode: 'auto' }`) calls a tool that answers `input_required` once, with `onprogress` set.

**Expected.** `onprogress` receives what the server sent.

**Actual.** It also receives a progress item the server never sent:

```
{"progress":1,"message":"Fulfilling input required by 'tools/call' (round 1)"}
```

**Why it mattered.** A voice or screen client that shows progress messages to the person would show this sentence to an older adult in the middle of a safety question.

**Workaround.** None needed in Hold On itself; a host has to filter it.

**Suggestion.** Mark progress that the SDK generates, or make it opt-in.

---

## F-10. Mouse automation misses buttons when the host scales the card with CSS `zoom`

**Severity:** Minor. This is about testing an embedded card, not a defect in MCP Apps.

**Steps taken.** Our simulator scales the card's iframe with CSS `zoom` (0.81 in a phone-sized frame). In Puppeteer, `frame.waitForSelector('button.approve')` then `elementHandle.click()`.

**Expected.** The button is pressed.

**Actual.** Puppeteer reported the button's box at y = 365 on a page where it is drawn at about y = 318 to 357. The click landed below the button, no tool was called, and the script ended with

```
Waiting failed: 15000ms exceeded
```

**Workaround.** Work out the point ourselves (the iframe's box plus the button's rectangle in the frame times the zoom factor) and use `page.mouse.click` (`scripts/screenshots.mjs`).

**Suggestion.** A note for host authors in the MCP Apps documentation: scaling the iframe with `zoom` breaks coordinate-based automation inside it.

---

## F-11. `skills-ref validate` exists, but the specification does not say how to get it

**Severity:** Minor.

**Task attempted.** Check that `skills/holdon-money-safety/SKILL.md` is a valid Agent Skill.

**Steps taken.** We first wrote our own frontmatter test from the format rules (`test/docs.test.ts`). Only when we re-read the specification while preparing this log did we notice its Validation section, which gives one line, `skills-ref validate ./my-skill`, and a link to a directory on GitHub, with no install step.

**Actual.** After guessing the invocation, it worked on the first try:

```
$ uvx --from "git+https://github.com/agentskills/agentskills#subdirectory=skills-ref" skills-ref validate ./skills/holdon-money-safety
Valid skill: skills/holdon-money-safety
```

**Suggestion.** Put a copy-and-paste command in the specification, and publish the validator to a package registry.

---

## F-12. A skill cannot declare the MCP tools it depends on

**Severity:** Minor, but it matters for any submission that pairs an Agent Skill with an MCP server.

**Task attempted.** Package the instructions for using Hold On's tools as a skill that a host can install on its own.

**Actual.** The frontmatter has `compatibility` (free text, at most 500 characters) and `allowed-tools` (experimental, and about pre-approval). Neither lets a skill say "this needs an MCP server that offers `holdon_check_request`". Our skill is useless without those tools, and a host has no way to know.

**Workaround.** A sentence in `compatibility`, and a test (`test/docs.test.ts`) that every `holdon_*` name in the skill exists in the server's `tools/list`.

**Suggestion.** A structured `requires` field for MCP servers or tool names, so a host can warn when a skill is installed without what it needs.

---

## F-13. "2025-11-25 or a later version, once confirmed"

**Severity:** Minor.

**Task attempted.** Decide which MCP revision to build for.

**Actual.** The Official Rules ask for "MCP spec version 2025-11-25 (or a later version, once confirmed) over Streamable HTTP". The current TypeScript SDK leads with 2026-07-28, which changes how a server asks the user for input. The rules do not say which revision a judge's client will speak, nor which optional features (elicitation, progress, icons, MCP Apps) count.

**Workaround.** Serve both revisions from one set of tool definitions, and prove 2025-11-25 with a raw `initialize` test.

**Suggestion.** Name the revision and the optional features the Alexa+ client uses, even provisionally.

---

## F-14. No Alexa+ developer tooling was available to participants

**Severity:** Blocker for testing on the target platform. It did not block building.

**Task attempted.** Check Hold On against the assistant it is designed for.

**Actual.** The hackathon FAQ says: "Amazon's Alexa+ Add-on developer tools (Category SDK, MCP Toolkit, CLI, and Web Simulator) are in preview and available to select partners only - there is currently no way for hackathon participants to apply for or gain access."

So we could not find out, and do not claim to know:

- which MCP revision the Alexa+ client negotiates, and whether it keeps a session
- whether it supports form elicitation, progress notifications, tool icons or MCP Apps cards, and how it would speak or show them
- how it would give two members of a household different tokens or roles on the same add-on
- whether an add-on can make a second person's device speak up when a hold is placed
- how it loads an Agent Skill next to an MCP server

**Workaround.** A simulator of our own that acts as a real MCP client over Streamable HTTP, as the FAQ allows.

**Suggestion.** Publish what the Alexa+ MCP client sends: a recorded `initialize`, its declared capabilities, and how it presents elicitation and cards. A public web simulator, even a limited one, would let participants test the experience instead of imagining it.
