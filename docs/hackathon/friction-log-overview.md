# Friction log: Hold On and Voicestage

Hold On (this repository) is a self-hosted MCP server with an Agent Skill and MCP Apps cards, built for the Alexa+ track of the Build, Ship, Shape developer hackathon. [Voicestage](https://github.com/needsbuilder/voicestage) is the simulator it was demonstrated on: an MCP client and host. Each project keeps its own friction log:

- [Hold On's log](friction-log.md): entries F-01 to F-14, the server side.
- [Voicestage's log](https://github.com/needsbuilder/voicestage/blob/main/docs/hackathon/friction-log.md): entries V-01 to V-15, the client and host side.

This page has the ten entries that cost us the most, in the hackathon's format: task attempted, steps taken, expected vs. actual result, severity, workaround and suggestion. All error text is copied from a terminal or from Chrome, reproduced on 2026-10-11. The other 18 entries (F-04 to F-13, V-06, V-07, V-09 to V-14) are in the two logs.

No Alexa+ developer tooling was available to hackathon participants. Nothing here is a statement about how the real Alexa+ runtime behaves.

## 1. No Alexa+ developer tooling for participants (F-14, V-15)

- Task: try a self-hosted MCP server and an Agent Skill the way a person would use them: by voice, on a device with a screen, with a second person on another device.
- Steps: read the rules, the FAQ and the resources page for a simulator, a command-line tool or device access.
- Expected vs. actual: some way to check against the target. The FAQ says the Category SDK, MCP Toolkit, CLI and Web Simulator are "in preview and available to select partners only".
- Severity: blocker for testing on the target platform. It did not block building.
- Workaround: we built Voicestage, a simulator that acts as a real MCP client. Every choice in it about what is spoken and what is shown is ours.
- Suggestion: publish a behaviour contract that needs no tool access: the revision and capabilities the client declares, how elicitation and cards are presented, how something reaches a person who did not ask.

## 2. The default HTTP handler cannot elicit from 2025-11-25 clients (F-01)

- Task: one server over Streamable HTTP that negotiates 2025-11-25 and asks one safety question by form elicitation.
- Steps: `createMcpHandler(factory)` with default options on `createMcpExpressApp()`; a tool that returns `inputRequired(...)`; a client that declares form elicitation.
- Expected vs. actual: the legacy shim sends `elicitation/create`. Instead the tool call returns "Cannot request input 'q' (elicitation/create): ... per-request legacy serving cannot receive server-to-client requests". The same handler works on 2026-07-28.
- Severity: major. The track's minimum revision loses server-to-client requests under the default entry point.
- Workaround: route by era ourselves: `isLegacyRequest()` sends 2025-era traffic to one `NodeStreamableHTTPServerTransport` per session, with our own session map, idle sweep and token check.
- Suggestion: offer the sessionful path as an option of `createMcpHandler`, and say in the README what the stateless fallback cannot do.

## 3. After a server restart the client keeps its dead session (V-01)

- Task: keep one long-lived MCP client per simulated device usable while the server under it is restarted.
- Steps: connect on 2025-11-25, call a tool, stop the server, call, start the server again, call.
- Expected vs. actual: the transport specification says a client MUST start a new session after a 404. The SDK's client throws `TypeError: fetch failed` while the server is down, then `SdkHttpError code=CLIENT_HTTP_NOT_IMPLEMENTED status=404` on every later call, and keeps the old session id.
- Severity: major. A simulator's user restarts their server all day.
- Workaround: the host pings before a request after idle time, reconnects on 404 and resends only requests that cannot have arrived.
- Suggestion: re-initialize on such a 404, or throw a named error such as `SessionExpiredError`.

## 4. Telling the person something when no request is in flight (V-03)

- Task: Sarah denies a hold on her phone; Margaret's kitchen display has to say so. Nothing on Margaret's device is waiting on a request.
- Steps: looked for the MCP message a server uses to push something meant for the person. The nearest is a logging notification.
- Expected vs. actual: one notification that works on both revisions. Logging is a developer channel and its control is marked deprecated as of 2026-07-28; on 2026-07-28 there is no session, and `sendLoggingMessage` afterwards throws `Not connected`.
- Severity: major for a voice-first product.
- Workaround: a server-sent events channel beside MCP, with rules that turn an event into an indicator, a spoken sentence and a tool call.
- Suggestion: a standard notification for events meant for the person: a short text that may be spoken, a priority, a tool to call for details, and replay after reconnecting.

## 5. MCP Apps requires a sandbox proxy, and the package has none (V-02)

- Task: render `ui://` cards in a web page with the official host bridge.
- Steps: installed `@modelcontextprotocol/ext-apps` and looked in the package for the page that goes in the outer iframe.
- Expected vs. actual: a proxy document or a helper. The package has no `.html` file, and its README says there is no supported host. Our first host, a single sandboxed iframe, worked, but did not conform: a card that reads `localStorage` threw `SecurityError`.
- Severity: major.
- Workaround: we wrote the proxy (178 lines) on a second origin, and had to decide alone where the card's policy is applied, which origin to use, and how to keep cards away from the host's own API.
- Suggestion: ship the proxy page in the npm package with a few lines of Node to serve it.

## 6. The approval form was refused with `Invalid Origin header: null` (F-02)

- Task: serve a plain HTML page with an Approve / Deny form from the same Express app as the MCP endpoint.
- Steps: `createMcpExpressApp()` plus our own routes; the page sent `Referrer-Policy: no-referrer`; pressed Approve in headless Chrome.
- Expected vs. actual: the hold is approved. Instead HTTP 403 with a JSON-RPC body. Chrome sends `Origin: null` under `no-referrer`, and the guard that `createMcpExpressApp()` installs covers every route on the app. Our tests posted with `fetch` and no `Origin` header, so they passed. Half of this is our own bug.
- Severity: major. The human approval step did nothing in a real browser.
- Workaround: `Referrer-Policy: same-origin`, a regression test that posts with an `Origin` header, and a script that presses the button in real Chrome.
- Suggestion: say in the README that the guards cover the whole app, list the ordinary cases that produce `Origin: null`, and offer an option to scope them to the MCP path.

## 7. Bundling the MCP Apps `App` class made each card about 590 kB (F-03)

- Task: three small self-contained cards with no network access.
- Steps: each view imported `App` and was bundled with esbuild, minified.
- Expected vs. actual: a few kilobytes. The build printed 593 kB, 597 kB and 592 kB.
- Severity: major for small cards.
- Workaround: about 80 lines that write the few messages a card needs by hand. The cards are now 10 to 18 kB, and tests drive each one with the official `AppBridge`.
- Suggestion: ship a small view client without schema validation, or document the minimal wire messages as a supported way to write a view.

## 8. Chrome's fake-microphone flags do not reach speech recognition (V-04)

- Task: test voice input end to end with nobody in the room.
- Steps: Chrome with `--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture=<wav>`, then `new SpeechRecognition().start()`.
- Expected vs. actual: the recogniser hears the file. It ends with `no-speech` after about 8.3 seconds.
- Severity: major for testing.
- Workaround: `recognition.start(track)` with a WebAudio track made from the WAV plus continuous faint noise. All twelve spoken lines were then recognised.
- Suggestion: send recognition's capture through the fake device when those flags are set, and document `start(MediaStreamTrack)` for testing.

## 9. Speech is refused until the page is clicked (V-05)

- Task: speak the assistant's replies with `speechSynthesis` as soon as a scenario plays.
- Steps: load the page and call `speak()` with no click or key press.
- Expected vs. actual: sound, or an exception. Nothing is thrown; the utterance gets an `error` event with `not-allowed`. The default voice on a Korean-language Mac is Korean.
- Severity: major until explained on screen. An announcement arriving on an idle stage was dropped.
- Workaround: a notice on the page, lines that stay on screen for as long as they would take to say, and voices chosen by name.
- Suggestion: a "may I speak yet?" state in the Web Speech API, and quality metadata on voices.

## 10. A live model does not speak the server's words (V-08)

- Task: have the assistant say exactly what Hold On wants said when a payment is stopped. The wording was written for a frightened older person.
- Steps: the tools return a `say_to_user` string, the skill says to say it as written, and we ran the scenario with a live model.
- Expected vs. actual: the sentence as written. The model reworded it and added a sentence of its own. Every expectation of the scenario still passed.
- Severity: minor for us, because recordings use the scripted provider.
- Workaround: the scripted provider speaks the text verbatim.
- Suggestion: a standard, optional field on a tool result for text the host may speak as written.
