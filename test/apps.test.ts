/**
 * MCP Apps: the `ui://` cards.
 *
 * The cards are loaded in jsdom and driven by the official host implementation,
 * `AppBridge` from @modelcontextprotocol/ext-apps, whose tool calls are
 * forwarded to a real MCP client connected to a real Hold On server. A click on
 * "Deny" in the card therefore travels the whole path a host would use.
 */
import type { Client } from '@modelcontextprotocol/client';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containsActionableContact } from '../src/domain/text.js';
import { CONTACT_TOKEN, MEMBER_TOKEN, SCENARIOS, call, connect, startTestServer, type TestServer } from './helpers.js';

let t: TestServer;
let margaret: Client & { asked: string[] };
let sarah: Client & { asked: string[] };
const cards: Array<{ close(): void }> = [];

beforeEach(async () => {
  t = await startTestServer();
  margaret = await connect(t.url, MEMBER_TOKEN);
  sarah = await connect(t.url, CONTACT_TOKEN);
});
afterEach(async () => {
  cards.splice(0).forEach((card) => card.close());
  await Promise.allSettled([margaret.close(), sarah.close()]);
  await t.close();
});

async function readCard(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  const content = result.contents[0] as { mimeType?: string; text?: string };
  expect(content.mimeType).toBe(RESOURCE_MIME_TYPE);
  return content.text!;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Load a card in jsdom and connect the official AppBridge to it as the host. */
async function openCard(html: string, client: Client) {
  const fromCard: unknown[] = [];
  let deliver: ((message: unknown) => void) | undefined;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://card.invalid/',
    beforeParse(window) {
      // In jsdom the top-level window is its own parent: messages the card posts to
      // its "host" arrive here with no source, which is how we tell them apart.
      window.addEventListener('message', (event: MessageEvent) => {
        if (event.source) return;
        if (deliver) deliver(event.data);
        else fromCard.push(event.data);
      });
    },
  });
  const { window } = dom;
  const transport = {
    onmessage: undefined as ((message: any) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    async start() {
      deliver = (message) => this.onmessage?.(message);
      fromCard.splice(0).forEach((message) => this.onmessage?.(message));
    },
    async send(message: unknown) {
      window.dispatchEvent(new window.MessageEvent('message', { data: message, source: window.parent }));
    },
    async close() {
      deliver = undefined;
    },
  };

  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const bridge = new AppBridge(null, { name: 'test-host', version: '1.0.0' }, { serverTools: {} });
  bridge.oncalltool = async (params) => {
    calls.push({ name: params.name, arguments: params.arguments as Record<string, unknown> });
    return (await client.callTool({ name: params.name, arguments: params.arguments })) as never;
  };
  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });
  await bridge.connect(transport as never);
  await initialized;

  const card = {
    window,
    document: window.document,
    bridge,
    calls,
    text: () => window.document.getElementById('root')!.textContent ?? '',
    button: (label: string) => [...window.document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined,
    close: () => window.close(),
  };
  cards.push(card);
  return card;
}

describe('MCP Apps metadata', () => {
  it('links tools to their cards through _meta.ui.resourceUri', async () => {
    const memberTools = Object.fromEntries((await margaret.listTools()).tools.map((tool) => [tool.name, tool]));
    for (const name of ['holdon_place_hold', 'holdon_get_hold', 'holdon_wait_for_decision', 'holdon_cancel_hold']) {
      expect((memberTools[name]!._meta as any).ui.resourceUri, name).toBe('ui://holdon/hold-card.html');
      // The key older hosts read is filled in by registerAppTool.
      expect((memberTools[name]!._meta as any)['ui/resourceUri'], name).toBe('ui://holdon/hold-card.html');
    }
    expect((memberTools.holdon_pay!._meta as any).ui.resourceUri).toBe('ui://holdon/receipt-card.html');
    expect(memberTools.holdon_check_request!._meta).toBeUndefined();

    const contactTools = Object.fromEntries((await sarah.listTools()).tools.map((tool) => [tool.name, tool]));
    expect((contactTools.holdon_family_inbox!._meta as any).ui.resourceUri).toBe('ui://holdon/approval-card.html');
    expect((contactTools.holdon_family_decide!._meta as any).ui.resourceUri).toBe('ui://holdon/approval-card.html');
  });

  it('lists each role only its own cards', async () => {
    const memberCards = (await margaret.listResources()).resources;
    expect(memberCards.map((r) => r.uri).sort()).toEqual(['ui://holdon/hold-card.html', 'ui://holdon/receipt-card.html']);
    expect(memberCards.every((r) => r.mimeType === RESOURCE_MIME_TYPE)).toBe(true);
    expect((await sarah.listResources()).resources.map((r) => r.uri)).toEqual(['ui://holdon/approval-card.html']);
    await expect(margaret.readResource({ uri: 'ui://holdon/approval-card.html' })).rejects.toThrow();
  });

  it('serves self-contained cards: one file, no network, no links, no inline HTML writes', async () => {
    const html = [
      await readCard(margaret, 'ui://holdon/hold-card.html'),
      await readCard(margaret, 'ui://holdon/receipt-card.html'),
      await readCard(sarah, 'ui://holdon/approval-card.html'),
    ];
    for (const page of html) {
      expect(page).toContain('<html lang="en">');
      expect(page).toContain('<main id="root" aria-live="polite">');
      expect(page).toContain('telephone=no');
      expect(page.length).toBeLessThan(40_000);
      expect(page).not.toMatch(/https?:\/\//);
      expect(page).not.toMatch(/<a[\s>]|<link|<img|<iframe|src=/i);
      expect(page).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|createElement\(["']a["']\)/);
      expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
    }
  });
});

describe('hold card (older adult)', () => {
  it('shows a stopped request calmly, with nothing actionable from the message', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.irsGiftCards);
    const placed = await margaret.callTool({
      name: 'holdon_place_hold',
      arguments: { check_id: check.check_id, summary: 'IRS agent wants $2,000 in gift cards, call 1-888-555-0142 or visit irs-settlement-desk.com' },
    });
    const card = await openCard(await readCard(margaret, 'ui://holdon/hold-card.html'), margaret);
    await card.bridge.sendToolResult(placed as never);
    await until(() => card.text().includes('Stopped'), 'the hold card to render');

    expect(card.document.querySelector('h1')!.textContent).toBe('Stopped');
    expect(card.text()).toContain('This will not be paid. Your family has been told.');
    expect(card.text()).toContain('Sarah Ellis (daughter)');
    expect(card.text()).toContain('payments are simulated');
    expect(card.document.querySelectorAll('a, [href], img, iframe')).toHaveLength(0);
    expect(card.text()).not.toContain('555');
    expect(card.text()).not.toContain('irs-settlement-desk');
    expect(containsActionableContact(card.text())).toBe(false);

    // The same holds for the full hold view returned by holdon_get_hold.
    await card.bridge.sendToolResult((await margaret.callTool({ name: 'holdon_get_hold', arguments: { hold_id: (placed.structuredContent as any).hold_id } })) as never);
    await until(() => card.text().includes('Internal Revenue Service'), 'the hold view to render');
    expect(card.text()).toContain('$2,000');
    expect(containsActionableContact(card.text())).toBe(false);
  });

  it('lets the person check for an answer, which calls holdon_get_hold through the host', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await margaret.callTool({ name: 'holdon_place_hold', arguments: { check_id: check.check_id, summary: 'Electric bill' } });
    const holdId = (placed.structuredContent as any).hold_id as string;
    const card = await openCard(await readCard(margaret, 'ui://holdon/hold-card.html'), margaret);
    await card.bridge.sendToolResult(placed as never);
    await until(() => Boolean(card.button('Check for an answer')), 'the check button');
    expect(card.document.querySelector('h1')!.textContent).toBe('On hold');

    await call(sarah, 'holdon_family_decide', { hold_id: holdId, decision: 'approve', note: 'Go ahead, Mom.' });
    card.button('Check for an answer')!.click();
    await until(() => card.document.querySelector('h1')?.textContent === 'Approved', 'the approved state');

    expect(card.calls).toEqual([{ name: 'holdon_get_hold', arguments: { hold_id: holdId } }]);
    expect(card.text()).toContain('Sarah Ellis');
    expect(card.text()).toContain('Go ahead, Mom.');
    expect(card.text()).toContain('$182.40');
    expect(card.button('Check for an answer')).toBeUndefined();
  });

  it('shows a tool error as plain text instead of an empty card', async () => {
    const card = await openCard(await readCard(margaret, 'ui://holdon/hold-card.html'), margaret);
    await card.bridge.sendToolResult((await margaret.callTool({ name: 'holdon_get_hold', arguments: { hold_id: 'hold_missing' } })) as never);
    await until(() => card.text().includes('No hold with id'), 'the error text');
    expect(card.document.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('receipt card', () => {
  it('shows a simulated payment receipt', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' });
    await call(sarah, 'holdon_family_decide', { hold_id: placed.hold_id, decision: 'approve' });
    const paid = await margaret.callTool({ name: 'holdon_pay', arguments: { hold_id: placed.hold_id } });

    const card = await openCard(await readCard(margaret, 'ui://holdon/receipt-card.html'), margaret);
    await card.bridge.sendToolResult(paid as never);
    await until(() => card.text().includes('SIMULATED PAYMENT'), 'the receipt to render');
    expect(card.document.querySelector('h1')!.textContent).toBe('$182.40 paid');
    expect(card.text()).toContain('To Con Edison');
    expect(card.text()).toContain('Credit or debit card');
    expect(card.text()).toContain((paid.structuredContent as any).confirmation);
  });
});

describe('approval card (trusted contact)', () => {
  it('shows the full context and denies a stopped request through holdon_family_decide', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.irsGiftCards);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Someone claiming to be the IRS wants $2,000 in gift cards.' });

    const card = await openCard(await readCard(sarah, 'ui://holdon/approval-card.html'), sarah);
    await card.bridge.sendToolResult((await sarah.callTool({ name: 'holdon_family_inbox', arguments: {} })) as never);
    await until(() => Boolean(card.button('Deny')), 'the approval card to render');

    expect(card.document.querySelector('h1')!.textContent).toBe('Margaret Ellis asked to make a payment');
    expect(card.text()).toContain('Stopped by Hold On');
    expect(card.text()).toContain('$2,000');
    expect(card.text()).toContain('Asked to pay with gift cards or a prepaid card');
    expect(card.text()).toContain('"No real business or government agency will ever tell you to buy a gift card to pay them."');
    expect(card.text()).toContain('Federal Trade Commission');
    expect(card.text()).toContain('800-829-1040');
    // The caller's number is shown as struck-through text for context, never as a link.
    expect(card.document.querySelector('.untrusted')!.textContent).toBe('1-888-555-0142');
    expect(card.document.querySelectorAll('a, [href]')).toHaveLength(0);
    // A stopped request offers Deny only.
    expect(card.button('Approve')).toBeUndefined();
    expect(card.text()).toContain('This request cannot be approved.');

    (card.document.getElementById('note') as HTMLTextAreaElement).value = 'Mom, that was not the IRS. Calling you now.';
    card.button('Deny')!.click();
    await until(() => card.document.querySelector('h1')?.textContent === 'Denied', 'the denied state');

    expect(card.calls).toEqual([{ name: 'holdon_family_decide', arguments: { hold_id: placed.hold_id, decision: 'deny', note: 'Mom, that was not the IRS. Calling you now.' } }]);
    expect(t.store.getHold(placed.hold_id)).toMatchObject({ status: 'denied', decision_note: 'Mom, that was not the IRS. Calling you now.' });
    expect((await call<any>(margaret, 'holdon_get_hold', { hold_id: placed.hold_id })).status).toBe('denied');
  });

  it('approves a verified bill', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' });
    const card = await openCard(await readCard(sarah, 'ui://holdon/approval-card.html'), sarah);
    await card.bridge.sendToolResult((await sarah.callTool({ name: 'holdon_family_inbox', arguments: {} })) as never);
    await until(() => Boolean(card.button('Approve')), 'the approve button');
    expect(card.text()).toContain('Confirmed payee');
    expect(card.document.getElementById('trust')).toBeNull();

    card.button('Approve')!.click();
    await until(() => card.document.querySelector('h1')?.textContent === 'Approved', 'the approved state');
    expect(t.store.getHold(placed.hold_id)?.status).toBe('approved');
  });

  it('requires the vouch tick box for a payee outside the registry, and shows the server error if it is missing', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.contractorDeposit);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Roofer deposit' });
    const card = await openCard(await readCard(sarah, 'ui://holdon/approval-card.html'), sarah);
    await card.bridge.sendToolResult((await sarah.callTool({ name: 'holdon_family_inbox', arguments: {} })) as never);
    await until(() => Boolean(card.button('Approve')), 'the approve button');
    const trust = card.document.getElementById('trust') as HTMLInputElement;
    expect(trust).not.toBeNull();

    card.button('Approve')!.click();
    await until(() => (card.document.querySelector('[role="alert"]')?.textContent ?? '').length > 0, 'the error message');
    expect(card.document.querySelector('[role="alert"]')!.textContent).toMatch(/not in the registry of official payees/);
    expect(t.store.getHold(placed.hold_id)?.status).toBe('pending_family');
    expect(card.button('Approve')!.disabled).toBe(false);

    trust.checked = true;
    card.button('Approve')!.click();
    await until(() => card.document.querySelector('h1')?.textContent === 'Approved', 'the approved state');
    expect(card.calls.at(-1)).toEqual({ name: 'holdon_family_decide', arguments: { hold_id: placed.hold_id, decision: 'approve', trust_payee: true } });
    expect(t.store.getHold(placed.hold_id)?.status).toBe('approved');
    expect(card.text()).toContain('Greenleaf Roofing is now a confirmed payee for the family.');
  });

  it('says so when nothing is waiting', async () => {
    const card = await openCard(await readCard(sarah, 'ui://holdon/approval-card.html'), sarah);
    await card.bridge.sendToolResult((await sarah.callTool({ name: 'holdon_family_inbox', arguments: {} })) as never);
    await until(() => card.text().includes('Nothing is waiting'), 'the empty state');
    expect(card.document.querySelectorAll('button')).toHaveLength(0);
  });
});
