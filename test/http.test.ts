/**
 * The parts of the loop that need no MCP client at all: the live event stream
 * and the family approval page. Together with a browser they are enough to
 * run the whole flow.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTACT_TOKEN, MEMBER_TOKEN, SCENARIOS, startTestServer, type TestServer } from './helpers.js';

let t: TestServer;
const streams: Array<{ close(): void }> = [];

beforeEach(async () => {
  t = await startTestServer();
});
afterEach(async () => {
  streams.splice(0).forEach((stream) => stream.close());
  await t.close();
});

interface SseEvent {
  event: string;
  id?: string;
  data: any;
}

/** Minimal SSE reader over fetch: collects events and lets a test wait for the next one of a given type. */
async function openEvents(path: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(`${t.url}${path}`, { headers: { Accept: 'text/event-stream', ...headers }, signal: controller.signal });
  const events: SseEvent[] = [];
  const waiters: Array<() => void> = [];
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event: Partial<SseEvent> = {};
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event.event = line.slice(6).trim();
              else if (line.startsWith('id:')) event.id = line.slice(3).trim();
              else if (line.startsWith('data:')) event.data = JSON.parse(line.slice(5).trim());
            }
            if (event.event) {
              events.push(event as SseEvent);
              waiters.splice(0).forEach((wake) => wake());
            }
          }
        }
      } catch {
        // aborted by the test
      }
    })();
  }
  const stream = {
    response,
    events,
    close: () => controller.abort(),
    async next(type: string, skip = 0): Promise<SseEvent> {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = events.filter((event) => event.event === type)[skip];
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`No "${type}" event arrived. Saw: ${events.map((e) => e.event).join(', ')}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
    },
  };
  streams.push(stream);
  return stream;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function placeHold(scenario: Record<string, unknown>, summary: string) {
  const { check_id } = t.service.checkRequest(t.margaret, scenario as never);
  return t.service.placeHold(t.margaret, { check_id, summary }).hold;
}

describe('GET /events', () => {
  it('requires a bearer token', async () => {
    const stream = await openEvents('/events');
    expect(stream.response.status).toBe(401);
    expect((await openEvents('/events', bearer('wrong'))).response.status).toBe(401);
  });

  it('announces who is listening, then streams hold events with role-appropriate detail', async () => {
    const family = await openEvents('/events', bearer(CONTACT_TOKEN));
    const member = await openEvents(`/events?access_token=${MEMBER_TOKEN}`);
    expect(family.response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect((await family.next('ready')).data).toMatchObject({ user: { id: 'user_sarah', name: 'Sarah Ellis', role: 'contact' }, circle_id: 'circle_ellis' });
    expect((await member.next('ready')).data.user.role).toBe('member');

    const hold = placeHold({ ...SCENARIOS.irsGiftCards, urgency_claims: ['arrest_or_legal_threat'] }, 'IRS agent wants gift cards, call 1-888-555-0142');

    const created = await family.next('hold.created');
    expect(created.id).toMatch(/^\d+$/);
    expect(created.data).toMatchObject({ type: 'hold.created', circle_id: 'circle_ellis', hold: { hold_id: hold.id, status: 'pending_family', blocked: true, can_approve: false } });
    expect(created.data.hold.approval_url).toContain(`/approve/${hold.id}?t=`);
    expect(created.data.hold.untrusted_contact_details.claimed_phone).toBe('1-888-555-0142');
    expect(created.data.hold.risk_signals[0].source.url).toMatch(/^https:\/\//);

    const memberCreated = await member.next('hold.created');
    expect(memberCreated.data.hold).toMatchObject({ hold_id: hold.id, status: 'pending_family', next_step: 'wait' });
    const memberJson = JSON.stringify(memberCreated.data);
    expect(memberJson).not.toContain('approval_url');
    expect(memberJson).not.toContain('555-0142');
    expect(memberJson).not.toContain('untrusted_contact_details');

    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'deny', note: 'Not the real IRS.' });
    const decided = await member.next('hold.decided');
    expect(decided.data.hold).toMatchObject({ status: 'denied', decision: { by: 'Sarah Ellis', note: 'Not the real IRS.' } });
    expect((await family.next('hold.decided')).data.hold.status).toBe('denied');
  });

  it('streams approval, payment and policy changes', async () => {
    const family = await openEvents('/events', bearer(CONTACT_TOKEN));
    const member = await openEvents('/events', bearer(MEMBER_TOKEN));
    await family.next('ready');
    await member.next('ready');

    const hold = placeHold(SCENARIOS.utilityBill, 'Electric bill');
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    t.service.pay(t.margaret, { hold_id: hold.id });
    const paid = await family.next('hold.paid');
    expect(paid.data.hold).toMatchObject({ status: 'paid', receipt: { payee: 'Con Edison', amount_usd: 182.4, simulated: true } });
    expect((await member.next('hold.paid')).data.hold.receipt.confirmation).toMatch(/^SIM-/);

    t.service.updatePolicy(t.sarah, { approval_threshold_usd: 250 });
    expect((await family.next('policy.updated')).data.circle.policy.approval_threshold_usd).toBe(250);
    // The member's stream never carries the family's limits.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(member.events.map((event) => event.event)).not.toContain('policy.updated');
    expect(family.events.map((event) => event.event)).toEqual(['ready', 'hold.created', 'hold.decided', 'hold.paid', 'policy.updated']);
  });

  it('replays missed events after Last-Event-ID', async () => {
    const first = placeHold(SCENARIOS.utilityBill, 'Electric bill');
    placeHold(SCENARIOS.contractorDeposit, 'Roofer deposit');
    t.service.familyDecide(t.sarah, { hold_id: first.id, decision: 'approve' });

    const all = await openEvents('/events', { ...bearer(CONTACT_TOKEN), 'Last-Event-ID': '0' });
    await all.next('hold.decided');
    expect(all.events.map((event) => event.event)).toEqual(['ready', 'hold.created', 'hold.created', 'hold.decided']);

    const lastSeen = all.events[2]!.id!;
    const resumed = await openEvents('/events', { ...bearer(CONTACT_TOKEN), 'Last-Event-ID': lastSeen });
    await resumed.next('hold.decided');
    expect(resumed.events.map((event) => event.event)).toEqual(['ready', 'hold.decided']);
  });
});

describe('family approval page', () => {
  const approvalPath = (holdId: string) => new URL(t.service.approvalUrl(holdId, t.sarah.user_id)).pathname + new URL(t.service.approvalUrl(holdId, t.sarah.user_id)).search;

  it('shows the full context with sources, and approves through a plain form post', async () => {
    const hold = placeHold(SCENARIOS.utilityBill, 'Con Edison electric bill, $182.40');
    const url = t.service.approvalUrl(hold.id, t.sarah.user_id);
    expect(url.startsWith(`${t.url}/approve/${hold.id}?t=`)).toBe(true);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Margaret Ellis asked to make a payment');
    expect(html).toContain('$182.40');
    expect(html).toContain('Con Edison');
    expect(html).toContain('1-800-752-6633');
    expect(html).toContain('<button class="approve" type="submit" name="decision" value="approve">Approve</button>');
    expect(html).toContain('<label for="note">');
    expect(html).toMatch(/payment is simulated/);
    expect(html).not.toContain('<script');

    const token = new URL(url).searchParams.get('t')!;
    const posted = await fetch(`${t.url}/approve/${hold.id}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: token, decision: 'approve', note: 'Looks right, Mom.' }),
    });
    expect(posted.status).toBe(303);
    const done = await fetch(new URL(posted.headers.get('location')!, t.url));
    const doneHtml = await done.text();
    expect(doneHtml).toContain('You approved this request.');
    expect(doneHtml).not.toContain('value="approve"');

    expect(t.service.memberHoldView(t.store.getHold(hold.id)!)).toMatchObject({ status: 'approved', next_step: 'pay', decision: { by: 'Sarah Ellis', note: 'Looks right, Mom.' } });
    expect(t.service.pay(t.margaret, { hold_id: hold.id }).receipt.payee).toBe('Con Edison');
  });

  it('offers only Deny for a stopped request, shows the untrusted details as plain text, and refuses a forced approval', async () => {
    const hold = placeHold(
      { ...SCENARIOS.irsGiftCards, claimed_url: 'http://irs-settlement-desk.com/pay', urgency_claims: ['arrest_or_legal_threat'] },
      'IRS agent wants $2,000 in gift cards <script>alert(1)</script>',
    );
    const url = t.service.approvalUrl(hold.id, t.sarah.user_id);
    const html = await (await fetch(url)).text();
    expect(html).toContain('Stopped by Hold On');
    expect(html).toContain('This request cannot be approved.');
    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="deny"');
    // Sources are quoted and linked; the scammer's link and number are text only, never links.
    expect(html).toContain('No real business or government agency will ever tell you to buy a gift card to pay them.');
    expect(html).toContain('href="https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams"');
    expect(html).toContain('<span class="untrusted">1-888-555-0142</span>');
    expect(html).toContain('<span class="untrusted">http://irs-settlement-desk.com/pay</span>');
    expect(html).not.toContain('href="http://irs-settlement-desk.com');
    expect(html).not.toContain('href="tel:');
    // Stops phones from turning the untrusted number into a tap-to-call link.
    expect(html).toContain('<meta name="format-detection" content="telephone=no, email=no, address=no">');
    // Text from the request is escaped.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

    const token = new URL(url).searchParams.get('t')!;
    const forced = await fetch(`${t.url}/approve/${hold.id}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: token, decision: 'approve', trust_payee: 'true' }),
    });
    expect(forced.status).toBe(409);
    expect(await forced.text()).toContain('role="alert"');
    expect(t.store.getHold(hold.id)?.status).toBe('pending_family');

    const denied = await fetch(`${t.url}/approve/${hold.id}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: token, decision: 'deny' }),
    });
    expect(denied.status).toBe(303);
    expect(t.store.getHold(hold.id)?.status).toBe('denied');
  });

  it('asks the contact to vouch for a payee that is not in the registry', async () => {
    const hold = placeHold(SCENARIOS.contractorDeposit, 'Roofer deposit');
    const url = t.service.approvalUrl(hold.id, t.sarah.user_id);
    const token = new URL(url).searchParams.get('t')!;
    expect(await (await fetch(url)).text()).toContain('name="trust_payee"');

    const post = (fields: Record<string, string>) =>
      fetch(`${t.url}/approve/${hold.id}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: token, ...fields }) });

    const unticked = await post({ decision: 'approve' });
    expect(unticked.status).toBe(409);
    expect(await unticked.text()).toContain('tick the box');
    expect(t.store.getHold(hold.id)?.status).toBe('pending_family');

    expect((await post({ decision: 'approve', trust_payee: 'true' })).status).toBe(303);
    expect(t.store.getHold(hold.id)?.status).toBe('approved');
    expect(t.service.circleView('circle_ellis').trusted_payees.map((p) => p.name)).toEqual(['Greenleaf Roofing']);
  });

  it('rejects a missing, forged or mismatched link', async () => {
    const hold = placeHold(SCENARIOS.utilityBill, 'Electric bill');
    const other = placeHold(SCENARIOS.contractorDeposit, 'Roofer deposit');
    const token = new URL(t.service.approvalUrl(other.id, t.sarah.user_id)).searchParams.get('t')!;

    for (const path of [`/approve/${hold.id}`, `/approve/${hold.id}?t=forged.token`, `/approve/${hold.id}?t=${token}`]) {
      const response = await fetch(`${t.url}${path}`);
      expect(response.status, path).toBe(403);
      expect(await response.text()).toContain('This link cannot be used');
    }
    const posted = await fetch(`${t.url}/approve/${hold.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: token, decision: 'approve' }),
    });
    expect(posted.status).toBe(403);
    expect(t.store.getHold(hold.id)?.status).toBe('pending_family');
    expect(approvalPath(hold.id)).toContain(hold.id);
  });

  it('a link signed for the older adult does not open the page', async () => {
    const { signApprovalToken } = await import('../src/approval.js');
    const { TEST_SECRET } = await import('./helpers.js');
    const hold = placeHold(SCENARIOS.utilityBill, 'Electric bill');
    const memberToken = signApprovalToken(TEST_SECRET, hold.id, t.margaret.user_id);
    expect((await fetch(`${t.url}/approve/${hold.id}?t=${memberToken}`)).status).toBe(403);
  });
});

describe('outgoing webhook', () => {
  it('posts signed hold events to the configured URL', async () => {
    const { createServer } = await import('node:http');
    const { createHmac } = await import('node:crypto');
    const { startHoldOnServer } = await import('../src/http/app.js');
    const { TEST_SECRET } = await import('./helpers.js');

    const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
    const sink = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    const sinkPort = (sink.address() as { port: number }).port;

    const second = await startHoldOnServer({ service: t.service, secret: TEST_SECRET, port: 0, webhookUrl: `http://127.0.0.1:${sinkPort}/hook` });
    try {
      const hold = placeHold(SCENARIOS.utilityBill, 'Electric bill');
      const deadline = Date.now() + 3000;
      while (received.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toHaveLength(1);
      const { headers, body } = received[0]!;
      expect(headers['x-holdon-event']).toBe('hold.created');
      expect(headers['x-holdon-signature']).toBe(`sha256=${createHmac('sha256', TEST_SECRET).update(body).digest('hex')}`);
      expect(JSON.parse(body)).toMatchObject({ type: 'hold.created', hold: { hold_id: hold.id, member: { name: 'Margaret Ellis' } } });
    } finally {
      await second.close();
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });
});
