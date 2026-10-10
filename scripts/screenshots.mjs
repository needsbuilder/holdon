#!/usr/bin/env node
// Takes the screenshots in docs/screenshots with headless Chrome, and checks
// the family approval views against the "first screen" rule while it is there:
// everything marked `data-above-fold` (who is asking, the amount and payee, the
// verdict, the buttons or the cannot-be-approved statement with its reasons)
// must be visible on a phone without scrolling, and not covered by the buttons.
//
//   npm run screenshots                       standalone approval page only
//   npm run screenshots -- --stage http://localhost:4700
//                                             also the MCP Apps cards inside a
//                                             Voicestage phone frame and kitchen
//                                             display, light and dark, including
//                                             real clicks on Approve and Deny
//   npm run screenshots -- --stage <url> --only page   (or --only stage)
//
// Needs a running Hold On server with the demo circle (npm run seed:reset &&
// npm start) and Chrome (pass --chrome <path> or set CHROME_PATH). The stage
// part needs Voicestage started with its examples/holdon config, pointed at the
// same Hold On server. Pending holds left on the server are denied first, so
// run it against demo data only.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    holdon: { type: 'string', default: process.env.HOLDON_URL ?? 'http://localhost:8787' },
    stage: { type: 'string' },
    only: { type: 'string' },
    out: { type: 'string', default: join(root, 'docs', 'screenshots') },
    chrome: { type: 'string' },
  },
});

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2 };
const DESKTOP = { width: 1920, height: 1080, deviceScaleFactor: 1 };
const holdonUrl = values.holdon.replace(/\/$/, '');
const stageUrl = values.stage?.replace(/\/$/, '');
const out = resolve(values.out);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const SCENARIOS = {
  bill: {
    check: { description: "My Con Edison bill came in the mail. It's $182.40. Please pay it with my card.", payee_name: 'Con Edison', amount_usd: 182.4, payment_method: 'card', contact_channel: 'mail' },
    summary: 'Con Edison electric bill, $182.40, by card. The bill came in the mail.',
  },
  roofer: {
    check: { description: 'The roofer, Greenleaf Roofing, wants a $1,500 deposit by check before he starts on the gutters next week.', payee_name: 'Greenleaf Roofing', amount_usd: 1500, payment_method: 'check', contact_channel: 'in_person' },
    summary: 'Greenleaf Roofing asked for a $1,500 deposit by check before starting on the gutters next week.',
  },
  irsWithLink: {
    check: {
      description: "A man who said he was from the IRS just called. He says I'll be arrested unless I pay $2,000 in gift cards today, and he told me not to tell anyone. He gave me a website to pay on.",
      payee_name: 'IRS',
      amount_usd: 2000,
      payment_method: 'gift_card',
      contact_channel: 'phone_call',
      secrecy_requested: true,
      claimed_url: 'http://irs-settlement-desk.com/pay',
      urgency_claims: ['arrest_or_legal_threat', 'pay_immediately'],
    },
    summary: 'Someone claiming to be the IRS phoned, demanded $2,000 in gift cards today, and gave a website to pay on.',
  },
  irs: {
    check: {
      description: "A man who said he was from the IRS just called. He says I'll be arrested unless I pay $2,000 in gift cards today, and he told me not to tell anyone.",
      payee_name: 'IRS',
      amount_usd: 2000,
      payment_method: 'gift_card',
      contact_channel: 'phone_call',
      secrecy_requested: true,
      urgency_claims: ['arrest_or_legal_threat', 'pay_immediately'],
    },
    summary: 'Someone claiming to be the IRS phoned and demanded $2,000 in gift cards today, threatened arrest, and said to keep it secret.',
  },
};

const problems = [];
const report = [];

// --- Hold On over MCP ----------------------------------------------------------

async function connect(token) {
  const client = new Client({ name: 'holdon-screenshots', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${holdonUrl}/mcp`), { authProvider: { token: async () => token } }));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
  return result.structuredContent;
}

/** Deny whatever is still waiting, so each picture shows exactly one request. */
async function clearPending(contact) {
  const inbox = await call(contact, 'holdon_family_inbox', { limit: 50 });
  for (const hold of inbox.holds) await call(contact, 'holdon_family_decide', { hold_id: hold.hold_id, decision: 'deny', note: 'Cleared before taking screenshots.' });
}

async function placeHold(member, contact, scenario) {
  const check = await call(member, 'holdon_check_request', scenario.check);
  const placed = await call(member, 'holdon_place_hold', { check_id: check.check_id, summary: scenario.summary });
  const inbox = await call(contact, 'holdon_family_inbox', { status: 'all', limit: 50 });
  return inbox.holds.find((hold) => hold.hold_id === placed.hold_id);
}

// --- the first-screen rule -------------------------------------------------------

/** Runs in the page or card frame: where is everything that must be on the first screen? */
function measureFold() {
  const height = window.innerHeight;
  const box = (node) => {
    const rect = node.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), shown: rect.width > 0 && rect.height > 0 };
  };
  const actions = document.querySelector('[data-above-fold="actions"]');
  const actionsTop = actions ? actions.getBoundingClientRect().top : Infinity;
  const items = [...document.querySelectorAll('[data-above-fold]')].map((node) => {
    const name = node.getAttribute('data-above-fold');
    const rect = box(node);
    return {
      name,
      ...rect,
      onFirstScreen: rect.shown && rect.top >= 0 && rect.bottom <= height,
      // The buttons stick to the bottom edge; nothing that must be read may sit under them.
      underButtons: name !== 'actions' && rect.bottom > Math.round(actionsTop) + 1,
    };
  });
  const buttons = [...document.querySelectorAll('.decide button')].map((node) => ({ label: node.textContent, ...box(node) }));
  return {
    viewport: `${window.innerWidth}x${height}`,
    scrollY: Math.round(window.scrollY),
    documentHeight: document.documentElement.scrollHeight,
    items,
    buttons: buttons.map((button) => ({ ...button, onFirstScreen: button.shown && button.top >= 0 && button.bottom <= height })),
    reasons: [...document.querySelectorAll('ul.reasons > li')].map((node) => node.textContent.trim()),
    sourceLinks: [...document.querySelectorAll('ul.reasons a.source')].map((node) => node.getAttribute('href')),
    simulatedLabel: /simulated/i.test(document.body.textContent ?? ''),
  };
}

function judge(name, fold, expected) {
  const names = fold.items.map((item) => item.name);
  for (const want of expected) if (!names.includes(want)) problems.push(`${name}: "${want}" is not on the page`);
  for (const item of fold.items) {
    if (!item.onFirstScreen) problems.push(`${name}: "${item.name}" is not fully on the first screen (${item.top}..${item.bottom} in ${fold.viewport})`);
    if (item.underButtons) problems.push(`${name}: "${item.name}" is covered by the buttons`);
  }
  for (const button of fold.buttons) if (!button.onFirstScreen) problems.push(`${name}: the ${button.label} button is not on the first screen`);
  if (!fold.simulatedLabel) problems.push(`${name}: the card does not say that payments are simulated`);
  report.push({ name, ...fold });
  const where = fold.items.map((item) => `${item.name} ${item.top}-${item.bottom}`).join(', ');
  console.log(`  ${name}: viewport ${fold.viewport}, document ${fold.documentHeight}px; ${where}; buttons: ${fold.buttons.map((b) => `${b.label} ${b.top}-${b.bottom}`).join(', ') || 'none'}`);
}

async function save(target, file, options = {}) {
  const path = join(out, file);
  await target.screenshot({ path, ...options });
  console.log(`  saved ${path}`);
}

// --- standalone approval page ------------------------------------------------------

async function standalone(browser, member, contact) {
  console.log('\nStandalone approval page, 390x844');
  const page = await browser.newPage();
  await page.setViewport(PHONE);

  await clearPending(contact);
  const blocked = await placeHold(member, contact, SCENARIOS.irs);
  await page.goto(blocked.approval_url, { waitUntil: 'load' });
  judge('page, blocked', await page.evaluate(measureFold), ['who', 'amount', 'verdict', 'cannot-approve', 'reasons', 'actions']);
  await save(page, 'page-blocked-390x844.png');
  await colorScheme(page, 'dark');
  await page.goto(blocked.approval_url, { waitUntil: 'load' });
  judge('page, blocked, dark', await page.evaluate(measureFold), ['who', 'amount', 'verdict', 'cannot-approve', 'reasons', 'actions']);
  await save(page, 'page-blocked-dark-390x844.png');
  await colorScheme(page, 'light');

  // The same request when the caller also gave a link: one more reason, whose sentence already names the official website.
  await clearPending(contact);
  const withLink = await placeHold(member, contact, SCENARIOS.irsWithLink);
  await page.goto(withLink.approval_url, { waitUntil: 'load' });
  judge('page, blocked, with a link from the caller', await page.evaluate(measureFold), ['who', 'amount', 'verdict', 'cannot-approve', 'reasons', 'actions']);
  await save(page, 'page-blocked-with-link-390x844.png');

  await clearPending(contact);
  await contact.callTool({ name: 'holdon_update_policy', arguments: { remove_trusted_payee: 'Greenleaf Roofing' } });
  const roofer = await placeHold(member, contact, SCENARIOS.roofer);
  await page.goto(roofer.approval_url, { waitUntil: 'load' });
  judge('page, needs a vouch', await page.evaluate(measureFold), ['who', 'amount', 'verdict', 'actions']);
  await save(page, 'page-vouch-390x844.png');

  await clearPending(contact);
  const bill = await placeHold(member, contact, SCENARIOS.bill);
  await page.goto(bill.approval_url, { waitUntil: 'load' });
  judge('page, approvable', await page.evaluate(measureFold), ['who', 'amount', 'verdict', 'actions']);
  await save(page, 'page-approvable-390x844.png');
  await colorScheme(page, 'dark');
  await page.goto(bill.approval_url, { waitUntil: 'load' });
  judge('page, approvable, dark', await page.evaluate(measureFold), ['who', 'amount', 'verdict', 'actions']);
  await save(page, 'page-approvable-dark-390x844.png');
  await colorScheme(page, 'light');
  await page.goto(bill.approval_url, { waitUntil: 'load' });

  // Decide it the way a person would: open the message box, type, press Approve.
  await page.click('details.note summary');
  await page.type('#note', 'Looks right, Mom.');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('button.approve')]);
  const after = await call(member, 'holdon_get_hold', { hold_id: bill.hold_id });
  if (after.status !== 'approved' || after.decision?.note !== 'Looks right, Mom.') problems.push(`page: pressing Approve left the hold ${after.status}`);
  console.log(`  pressed Approve on the page: hold is now "${after.status}", note "${after.decision?.note}"`);

  // The same link opened again later: an already-decided hold.
  await page.goto(bill.approval_url, { waitUntil: 'load' });
  judge('page, decided', await page.evaluate(measureFold), ['who', 'amount', 'verdict', 'decision']);
  await save(page, 'page-decided-390x844.png');
  await page.close();

  // Margaret pays the approved bill; the receipt is the next card to look at.
  const receipt = await member.callTool({ name: 'holdon_pay', arguments: { hold_id: bill.hold_id } });
  if (receipt.isError) throw new Error(`holdon_pay: ${receipt.content?.[0]?.text}`);
  await receiptAlone(browser, member, { content: receipt.content, structuredContent: receipt.structuredContent });
}

// --- the MCP Apps card inside Voicestage's phone frame ------------------------------

async function stagePost(path, body = {}) {
  const response = await fetch(`${stageUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

const stageState = async () => (await fetch(`${stageUrl}/api/state`)).json();

async function stageUntil(what, test, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await stageState();
    if (test(snapshot)) return snapshot;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(120);
  }
}

/** Play the first steps of a Voicestage scenario, one at a time, until the phone shows the approval card. */
async function playUntilPhoneShowsCard(scenarioId, steps = 2) {
  await stagePost('/api/scenarios/stop').catch(() => undefined);
  // Anything said because of earlier holds (for example the ones just cleared) should be over first.
  await stageQuiet();
  await stagePost('/api/reset');
  await sleep(300);
  await stagePost(`/api/scenarios/${scenarioId}/play`, { mode: 'scripted', pacing: 'step' });
  for (let index = 0; index < steps; index += 1) {
    await stageUntil(`the run to wait before step ${index + 1}`, (snapshot) => snapshot.run?.waitingForNext === true || snapshot.run?.status !== 'running');
    await stagePost('/api/scenarios/next');
    await stageUntil(`step ${index + 1} to finish`, (snapshot) => ['passed', 'failed'].includes(snapshot.run?.steps[index]?.status));
  }
  await stageUntil('the approval card on the phone', (snapshot) => snapshot.devices.find((device) => device.id === 'phone')?.screen?.card?.uri === 'ui://holdon/approval-card.html');
  await stageQuiet();
}

/** Ask the browser for a light or dark page, as a system set to that scheme would. */
async function colorScheme(page, value) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value }]);
}

/** Open the stage and return the card's frame inside a device: the phone, or the kitchen display. */
async function openStage(page, viewport, device = 'phone') {
  await page.setViewport(viewport);
  const selector = `.device--${device} .app-card--ready iframe`;
  // The stage redraws a card when a new result arrives, which replaces its iframe; look again after it settles.
  for (let attempt = 1; ; attempt += 1) {
    await page.goto(`${stageUrl}/?voice=0&inspector=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(selector, { timeout: 20_000 });
    await page.$eval(`.device--${device}`, (node) => node.scrollIntoView({ block: 'start' }));
    await sleep(1500);
    const frame = await (await page.$(selector))?.contentFrame();
    const drawn = frame && (await frame.waitForSelector('#root section', { timeout: 5000 }).catch(() => null));
    if (drawn) return frame;
    if (attempt === 3) throw new Error(`The card on the ${device} did not settle.`);
  }
}

/** Wait until no device on the stage is thinking or speaking, so nothing is about to change on screen. */
async function stageQuiet() {
  let calm = 0;
  await stageUntil('the stage to go quiet', (snapshot) => {
    calm = snapshot.devices.every((device) => device.status === 'idle') ? calm + 1 : 0;
    return calm >= 5;
  });
}

/**
 * Press a button inside the card with the mouse, at the point where it is drawn.
 *
 * Voicestage scales the card with CSS `zoom`, which Puppeteer's own
 * `elementHandle.click()` does not account for inside a frame (it lands below
 * the button). So the point is worked out here: the iframe's place on the page
 * plus the button's place in the card, scaled. Nothing is scrolled.
 */
async function clickInCard(page, frame, selector) {
  const iframe = await page.$('.device--phone .app-card iframe');
  const outer = await iframe.boundingBox();
  const inner = await frame.$eval(selector, (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, viewport: window.innerWidth };
  });
  const zoom = outer.width / inner.viewport;
  const point = { x: outer.x + inner.x * zoom, y: outer.y + inner.y * zoom };
  await page.mouse.click(point.x, point.y);
  return point;
}

async function shootStage(page, name, file, expected, { dark = false } = {}) {
  const narrow = await openStage(page, PHONE);
  judge(`stage 390x844, ${name}`, await narrow.evaluate(measureFold), expected);
  await save(page, `stage-${file}-390x844.png`);
  // The size the demo is filmed at: the same phone frame on a 1920x1080 stage.
  const wide = await openStage(page, DESKTOP);
  judge(`stage 1920x1080, ${name}`, await wide.evaluate(measureFold), expected);
  await save(await page.$('.device--phone .frame'), `stage-phone-${file}-1920x1080.png`);
  if (!dark) return;
  // The same card when the system, and so the host, asks for dark.
  await colorScheme(page, 'dark');
  const night = await openStage(page, DESKTOP);
  judge(`stage 1920x1080 dark, ${name}`, await night.evaluate(measureFold), expected);
  await save(await page.$('.device--phone .frame'), `stage-phone-${file}-dark-1920x1080.png`);
  await colorScheme(page, 'light');
}

/** The card on the kitchen display, light and dark, cut out of the 1920x1080 stage. */
async function shootKitchen(page, name, file, expected) {
  for (const scheme of ['light', 'dark']) {
    await colorScheme(page, scheme);
    const frame = await openStage(page, DESKTOP, 'display');
    const label = scheme === 'dark' ? `${name}, dark` : name;
    if (expected) judge(`kitchen display 1920x1080, ${label}`, await frame.evaluate(measureFold), expected);
    await save(await page.$('.device--display .frame'), `stage-kitchen-${file}${scheme === 'dark' ? '-dark' : ''}-1920x1080.png`);
  }
  await colorScheme(page, 'light');
}

// --- one card on its own, in a stand-in host --------------------------------------

/**
 * A page that hosts one card in a sandboxed iframe and speaks just enough of
 * the MCP Apps protocol to show it: it answers ui/initialize, then sends the
 * tool result. Used to look at a card at a given size and theme without a
 * stage. The tests use the official AppBridge; this is only a picture frame.
 */
function standInHost(cardHtml, result, hostContext) {
  const data = JSON.stringify({ card: cardHtml, result, hostContext }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html, body { margin: 0; height: 100%; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style></head>
<body><iframe sandbox="allow-scripts" title="card"></iframe><script>
const data = ${data};
const frame = document.querySelector('iframe');
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return;
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  const reply = (body) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...body }, '*');
  if (message.method === 'ui/initialize') reply({ id: message.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'screenshot-host', version: '1.0.0' }, hostCapabilities: {}, hostContext: data.hostContext } });
  else if (message.method === 'ui/notifications/initialized') reply({ method: 'ui/notifications/tool-result', params: data.result });
  else if (message.id !== undefined) reply({ id: message.id, error: { code: -32601, message: 'Not available in the screenshot host' } });
});
frame.srcdoc = data.card;
</script></body></html>`;
}

async function showAlone(page, cardHtml, result, { scheme = 'light', theme } = {}) {
  await colorScheme(page, scheme);
  // A fresh document each time, so the frame found is this card and not the one before it.
  await page.goto('about:blank');
  await page.setContent(standInHost(cardHtml, result, theme ? { theme } : {}), { waitUntil: 'load' });
  const frame = await (await page.waitForSelector('iframe')).contentFrame();
  await frame.waitForSelector('#root section');
  await sleep(300);
  const colors = await frame.evaluate(() => ({ page: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.querySelector('h1')).color, theme: document.documentElement.dataset.theme ?? 'none' }));
  return { frame, colors };
}

/** The receipt card by itself at phone size, in both schemes, and with a host that names a theme the system does not. */
async function receiptAlone(browser, member, receiptResult) {
  console.log('\nReceipt card on its own, 390x844 (stand-in host)');
  const page = await browser.newPage();
  await page.setViewport(PHONE);
  const card = (await member.readResource({ uri: 'ui://holdon/receipt-card.html' })).contents[0].text;
  const expected = ['paid', 'payee', 'simulated', 'details'];

  const light = await showAlone(page, card, receiptResult);
  judge('receipt card 390x844', await light.frame.evaluate(measureFold), expected);
  await save(page, 'receipt-card-390x844.png');
  const dark = await showAlone(page, card, receiptResult, { scheme: 'dark' });
  judge('receipt card 390x844, dark', await dark.frame.evaluate(measureFold), expected);
  await save(page, 'receipt-card-dark-390x844.png');

  // The host's word wins over the system's, in both directions.
  const hostDark = await showAlone(page, card, receiptResult, { scheme: 'light', theme: 'dark' });
  const hostLight = await showAlone(page, card, receiptResult, { scheme: 'dark', theme: 'light' });
  console.log(`  system light: page ${light.colors.page}, text ${light.colors.text}`);
  console.log(`  system dark:  page ${dark.colors.page}, text ${dark.colors.text}`);
  console.log(`  system light, host says dark:  page ${hostDark.colors.page}, text ${hostDark.colors.text} (data-theme ${hostDark.colors.theme})`);
  console.log(`  system dark,  host says light: page ${hostLight.colors.page}, text ${hostLight.colors.text} (data-theme ${hostLight.colors.theme})`);
  if (dark.colors.page === light.colors.page) problems.push('receipt card: the dark scheme did not change the page colour');
  if (hostDark.colors.page !== dark.colors.page) problems.push('receipt card: a host that names the dark theme did not get it');
  if (hostLight.colors.page !== light.colors.page) problems.push('receipt card: a host that names the light theme did not get it');
  await page.close();
}

/** A press on a reason's source link asks the host to open it (MCP Apps ui/open-link); the card stays put. */
async function pressSourceLink(page) {
  const frame = await openStage(page, PHONE);
  const href = await frame.$eval('ul.reasons a.source', (node) => node.getAttribute('href'));
  const asked = new Promise((done) => page.once('dialog', (dialog) => done(dialog.message())));
  await clickInCard(page, frame, 'ul.reasons a.source');
  const message = await Promise.race([asked, sleep(5000).then(() => undefined)]);
  const snapshot = await stageState();
  const event = snapshot.devices
    .find((device) => device.id === 'phone')
    .timeline.filter((entry) => entry.kind === 'card' && entry.action === 'open-link')
    .at(-1);
  const stillThere = await frame.$('ul.reasons');
  console.log(`  pressed the first source link: the host was asked to open ${event?.detail?.url}; it ${message ? 'asked the person to confirm' : 'showed no prompt'}; the card ${stillThere ? 'stayed in place' : 'went away'}`);
  if (event?.detail?.url !== href) problems.push('stage: a press on a source link did not reach the host as ui/open-link');
  if (!stillThere) problems.push('stage: the card navigated away when a source link was pressed');
}

/** A real click on Deny in the embedded card for the stopped request. */
async function pressDeny(page, member) {
  const frame = await openStage(page, PHONE);
  const holdId = (await stageState()).devices.find((device) => device.id === 'phone').screen.result.structuredContent.holds[0].hold_id;
  const point = await clickInCard(page, frame, 'button.deny');
  await frame.waitForFunction(() => document.querySelector('h1')?.textContent === 'Denied', { timeout: 15_000 });
  const snapshot = await stageUntil('the kitchen display to announce the denial', (current) =>
    current.devices.find((device) => device.id === 'kitchen')?.timeline.some((entry) => entry.kind === 'speech' && /asked that it not be paid/.test(entry.text)),
  );
  const decide = snapshot.devices
    .find((device) => device.id === 'phone')
    .timeline.filter((entry) => entry.kind === 'tool' && entry.name === 'holdon_family_decide')
    .at(-1);
  const heard = snapshot.devices
    .find((device) => device.id === 'kitchen')
    .timeline.filter((entry) => entry.kind === 'speech')
    .map((entry) => entry.text)
    .slice(-2);
  const onServer = await call(member, 'holdon_get_hold', { hold_id: holdId });
  console.log(`  mouse click at ${Math.round(point.x)},${Math.round(point.y)} on Deny: ${decide?.name} called with ${JSON.stringify(decide?.arguments)}, origin "${decide?.origin}", result status "${decide?.result?.structuredContent?.status}"`);
  console.log(`  the kitchen display said: ${heard.map((text) => JSON.stringify(text)).join(' then ')}`);
  if (decide?.origin !== 'card' || onServer.status !== 'denied') problems.push('stage: the click on Deny did not reach holdon_family_decide from the card');
  await sleep(1200);
  await save(page, 'stage-denied-after-click-390x844.png');
}

async function stage(browser, member, contact) {
  console.log(`\nMCP Apps card inside the Voicestage phone frame (${stageUrl})`);
  const page = await browser.newPage();
  // The host asks before opening a link from a card; say no, nothing should leave the stage.
  page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));

  // A stopped request.
  await clearPending(contact);
  await playUntilPhoneShowsCard('a-irs-gift-cards');
  await shootStage(page, 'blocked', 'blocked', ['who', 'amount', 'verdict', 'cannot-approve', 'reasons', 'actions'], { dark: true });
  await stagePost('/api/scenarios/stop').catch(() => undefined);
  await pressSourceLink(page);
  await pressDeny(page, member);

  // A payee outside the registry: approving takes a tick in the vouch box.
  await clearPending(contact);
  await playUntilPhoneShowsCard('c-contractor-deposit', 3);
  await shootStage(page, 'needs a vouch', 'vouch', ['who', 'amount', 'verdict', 'actions']);
  await stagePost('/api/scenarios/stop').catch(() => undefined);

  // A request that can be approved.
  await clearPending(contact);
  await playUntilPhoneShowsCard('b-utility-bill');
  await shootStage(page, 'approvable', 'approvable', ['who', 'amount', 'verdict', 'actions'], { dark: true });

  // A real click on Approve in the embedded card, on the phone-sized stage.
  const frame = await openStage(page, PHONE);
  const before = await stageState();
  const holdId = before.devices.find((device) => device.id === 'phone').screen.result.structuredContent.holds[0].hold_id;
  await frame.waitForSelector('button.approve');
  const point = await clickInCard(page, frame, 'button.approve');
  console.log(`  mouse click at ${Math.round(point.x)},${Math.round(point.y)} on the 390x844 page, where Approve is drawn`);
  await frame.waitForFunction(() => document.querySelector('h1')?.textContent === 'Approved', { timeout: 15_000 });
  const snapshot = await stageUntil('the kitchen display to announce the decision', (current) =>
    current.devices.find((device) => device.id === 'kitchen')?.timeline.some((entry) => entry.kind === 'speech' && /Sarah said yes/.test(entry.text)),
  );
  const phone = snapshot.devices.find((device) => device.id === 'phone');
  const kitchen = snapshot.devices.find((device) => device.id === 'kitchen');
  const decide = phone.timeline.filter((entry) => entry.kind === 'tool' && entry.name === 'holdon_family_decide').at(-1);
  const heard = kitchen.timeline.filter((entry) => entry.kind === 'speech').map((entry) => entry.text).slice(-2);
  const onServer = await call(member, 'holdon_get_hold', { hold_id: holdId });
  console.log(`  clicked Approve in the card: ${decide?.name} called with ${JSON.stringify(decide?.arguments)}, origin "${decide?.origin}", result status "${decide?.result?.structuredContent?.status}"`);
  console.log(`  the kitchen display said: ${heard.map((text) => JSON.stringify(text)).join(' then ')}`);
  console.log(`  Hold On now reports the hold as "${onServer.status}", decided by ${onServer.decision?.by}`);
  if (decide?.origin !== 'card' || decide?.result?.structuredContent?.status !== 'approved') problems.push('stage: the click on Approve did not reach holdon_family_decide from the card');
  if (onServer.status !== 'approved') problems.push(`stage: after the click the hold is "${onServer.status}"`);
  await stagePost('/api/scenarios/stop').catch(() => undefined);
  await sleep(1200);
  await save(page, 'stage-approved-after-click-390x844.png');
  await page.setViewport(DESKTOP);
  await page.goto(`${stageUrl}/?voice=0&inspector=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.device--phone .app-card--ready iframe');
  await sleep(2000);
  await save(page, 'stage-approved-after-click-1920x1080.png');

  // An already-decided hold: Sarah opens her inbox with everything in it.
  await stagePost('/api/devices/phone/tool', { server: 'holdon', name: 'holdon_family_inbox', arguments: { status: 'all', limit: 1 }, origin: 'inspector' });
  await shootStage(page, 'decided', 'decided', ['who', 'amount', 'verdict', 'decision']);

  // Margaret's side, on the kitchen display: the approved hold, then the receipt once she pays.
  await shootKitchen(page, 'hold card', 'hold');
  await stagePost('/api/devices/kitchen/tool', { server: 'holdon', name: 'holdon_pay', arguments: { hold_id: holdId }, origin: 'inspector' });
  await stageUntil('the receipt on the kitchen display', (current) => current.devices.find((device) => device.id === 'kitchen')?.screen?.card?.uri === 'ui://holdon/receipt-card.html');
  await shootKitchen(page, 'receipt card', 'receipt', ['paid', 'payee', 'simulated', 'details']);
  await page.close();
}

async function main() {
  const executablePath = [values.chrome, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
    (path) => path && existsSync(path),
  );
  if (!executablePath) throw new Error('Chrome was not found. Pass --chrome <path> or set CHROME_PATH.');
  mkdirSync(out, { recursive: true });
  const member = await connect(process.env.HOLDON_MEMBER_TOKEN ?? 'demo-member-margaret');
  const contact = await connect(process.env.HOLDON_CONTACT_TOKEN ?? 'demo-contact-sarah');
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--hide-scrollbars', '--mute-audio'] });
  try {
    if (stageUrl && values.only !== 'page') await stage(browser, member, contact);
    if (values.only !== 'stage') await standalone(browser, member, contact);
  } finally {
    await browser.close();
    await Promise.allSettled([member.close(), contact.close()]);
  }
  console.log('\nReasons shown, one per item:');
  for (const entry of report.filter((item) => item.reasons.length > 0)) {
    console.log(`  ${entry.name}`);
    entry.reasons.forEach((text, index) => console.log(`    ${index + 1}. ${text}`));
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    problems.forEach((problem) => console.error(`  - ${problem}`));
    process.exit(1);
  }
  console.log('\nEverything that must be on the first screen is on the first screen.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
