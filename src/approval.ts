/**
 * The family approval web page.
 *
 * A trusted contact opens a signed link, reads the request and presses Approve
 * or Deny. The page is plain server-rendered HTML with no script, so it works
 * in any browser and with a screen reader. The link is a capability: it is
 * only ever handed to the trusted contact, never to the older adult.
 *
 * Laid out for a phone, like the MCP Apps approval card (ui/approval-card.js)
 * whose stylesheet it shares: who is asking, how much and to whom, the verdict
 * and the buttons are on the first screen; a stopped request shows there that
 * it cannot be approved and why. The rest is under "Details".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SIMULATED_FOOTER } from './domain/language.js';
import { channelName, extractHost, formatUsd, methodName } from './domain/text.js';
import type { HoldReason } from './domain/types.js';
import { packagePath } from './paths.js';
import type { FamilyHoldView } from './service.js';

const LINK_LIFETIME_MS = 7 * 24 * 3_600_000;

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signApprovalToken(secret: string, holdId: string, userId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ h: holdId, u: userId, e: now + LINK_LIFETIME_MS })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** Returns the contact's user id when the token is genuine, unexpired and issued for this hold. */
export function verifyApprovalToken(secret: string, token: string | undefined, holdId: string, now = Date.now()): string | undefined {
  if (!token) return undefined;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return undefined;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { h?: string; u?: string; e?: number };
    if (data.h !== holdId || typeof data.u !== 'string' || typeof data.e !== 'number' || data.e < now) return undefined;
    return data.u;
  } catch {
    return undefined;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let stylesheet: string | undefined;

/** The stylesheet shared with the MCP Apps cards, read once. */
function style(): string {
  stylesheet ??= readFileSync(packagePath('ui', 'card.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return stylesheet;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en" class="compact">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="format-detection" content="telephone=no, email=no, address=no">
<title>${escapeHtml(title)} | Hold On</title>
<style>
${style()}
</style>
</head>
<body>
<main>
${body}
<p class="small">${escapeHtml(SIMULATED_FOOTER)}</p>
</main>
</body>
</html>`;
}

export function renderMessagePage(title: string, message: string, tone: 'good' | 'caution' | 'stop' = 'caution'): string {
  return page(title, `<section class="card summary result ${tone}"><h1>${escapeHtml(title)}</h1><p class="say" role="status">${escapeHtml(message)}</p></section>`);
}

function row(term: string, value: string | undefined): string {
  return value ? `<dt>${escapeHtml(term)}</dt><dd>${value}</dd>` : '';
}

const STATUS_TEXT: Record<string, string> = {
  pending_family: 'Waiting for your decision',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired without a decision',
  paid: 'Paid (simulated)',
  cancelled: 'Cancelled by your family member',
};

const VERDICTS: Record<string, [label: string, tone: string]> = {
  stop: ['Stopped by Hold On', 'stop'],
  hold_for_family: ['Warning signs found', 'caution'],
  verified: ['Confirmed payee', 'good'],
  unknown: ['Payee could not be confirmed', 'caution'],
};

/**
 * A link to an official source, labelled with its website. The URL comes from
 * the rules or registry file; only https pages are linked.
 */
function sourceLink(source: { url: string; publisher?: string; title?: string } | undefined, mention?: string): string {
  const site = mention ?? (source ? extractHost(source.url) : undefined);
  if (!source || !site) return '';
  const name = [source.publisher, source.title].filter(Boolean).join(', ');
  // A website already named in the sentence keeps the sentence's own type size.
  const style = mention ? 'source in-text' : 'source';
  if (!/^https:\/\//.test(source.url)) return `<span class="${style}">${escapeHtml(site)}</span>`;
  return `<a class="${style}" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer noopener" title="${escapeHtml(name)}" aria-label="Source: ${escapeHtml(name || site)}">${escapeHtml(site)}</a>`;
}

/**
 * One reason: its text as given, and its source. When the text already names
 * the source's website ("...official site, irs.gov."), that mention becomes the
 * link; otherwise the website follows the text. Either way it is shown once.
 */
function reasonItem(reason: HoldReason): string {
  const mention = reason.source?.named_in_text;
  const at = mention ? reason.text.indexOf(mention) : -1;
  if (mention && at >= 0) {
    return `<li>${escapeHtml(reason.text.slice(0, at))}${sourceLink(reason.source, mention)}${escapeHtml(reason.text.slice(at + mention.length))}</li>`;
  }
  return `<li>${escapeHtml(reason.text)}${reason.source ? ` ${sourceLink(reason.source)}` : ''}</li>`;
}

/** One reason per item, each with its source where the data has one. */
function reasonList(reasons: HoldReason[]): string {
  return `<ul class="reasons" data-above-fold="reasons">${reasons.map(reasonItem).join('')}</ul>`;
}

/**
 * What became of a request that is no longer open, said once. Only the trusted
 * contact approves or denies; paying, cancelling and running out of time are
 * things that happened afterwards and are not theirs.
 */
function decisionLine(view: FamilyHoldView): string {
  const by = view.decision ? ` by ${escapeHtml(view.decision.by)}` : '';
  if (view.status === 'denied') return `<strong>Denied</strong>${by}.`;
  if (view.status === 'approved') return `<strong>Approved</strong>${by}.`;
  const approved = view.decision ? `<strong>Approved</strong>${by}. ` : '';
  if (view.status === 'paid') return `${approved}Paid (simulated).`;
  if (view.status === 'expired') return view.decision ? `${approved}Expired before it was paid.` : 'Expired without a decision.';
  if (view.status === 'cancelled') return `${approved}Cancelled by your family member.`;
  return `${escapeHtml(STATUS_TEXT[view.status] ?? view.status)}.`;
}

export function renderApprovalPage(view: FamilyHoldView, options: { token: string; justDecided?: boolean; error?: string }): string {
  const [verdictLabel, verdictTone] = VERDICTS[view.verdict] ?? ['Request', 'neutral'];
  const tone = view.blocked ? 'stop' : verdictTone;
  const member = escapeHtml(view.member.name);
  const open = view.status === 'pending_family';
  const amount = view.amount_usd !== undefined ? formatUsd(view.amount_usd) : 'No amount given';
  const meta = [methodName(view.payment_method), channelName(view.contact_channel), view.secrecy_requested ? 'Told to keep it secret' : undefined].filter(Boolean).join(' · ');
  // A stopped request leads with what stops it; anything else shows every warning sign.
  const listed = view.blocked ? view.reasons.filter((reason) => reason.blocking) : view.reasons;
  // What is true right now, next to the verdict. A stopped request is not "waiting for a
  // decision": nothing will be paid whatever is pressed. A request that is no longer open
  // says nothing here; the decision box below says it once.
  const state = !open ? undefined : view.blocked ? 'Nothing will be paid' : STATUS_TEXT.pending_family;

  let why: string;
  if (view.blocked) {
    why = `<p class="cannot" data-above-fold="cannot-approve"><strong>This request cannot be approved.</strong></p>${listed.length > 0 ? `<h2 class="list-title">Why it was stopped</h2>${reasonList(listed)}` : ''}`;
  } else {
    const cannot = open && !view.can_approve && view.cannot_approve_reason ? `<p class="cannot" data-above-fold="cannot-approve"><strong>This request cannot be approved.</strong> ${escapeHtml(view.cannot_approve_reason)}</p>` : '';
    why = cannot + (listed.length > 0 ? `<h2 class="list-title">Warning signs</h2>${reasonList(listed)}` : '<p class="calm">No known scam pattern matched this request.</p>');
  }

  const summary = `<section class="card summary ${tone}" aria-labelledby="who">
<p class="eyebrow">Hold On · simulated payments</p>
<h1 id="who" data-above-fold="who">${member} asked to make a payment</h1>
<p class="amount" data-above-fold="amount">${escapeHtml(amount)}<span class="to"> to </span>${view.payee_name ? escapeHtml(view.payee_name) : 'no payee named'}</p>
<p class="meta">${escapeHtml(meta)}</p>
<p class="verdict" data-above-fold="verdict"><span class="tag ${tone}">${escapeHtml(verdictLabel)}</span>${state ? `<span class="state">${escapeHtml(state)}</span>` : ''}</p>
${why}
</section>`;

  let decision: string;
  if (open) {
    const trust = view.requires_trust_payee
      ? `<label class="check" for="trust_payee"><input type="checkbox" id="trust_payee" name="trust_payee" value="true"><span>I personally know and trust <strong>${escapeHtml(view.payee_name ?? 'this payee')}</strong>. Hold On could not find them in its registry of official payees. (Needed to approve.)</span></label>`
      : '';
    const approve = view.can_approve ? `<button class="approve" type="submit" name="decision" value="approve">Approve</button>` : '';
    decision = `<form class="decide" method="post" action="/approve/${encodeURIComponent(view.hold_id)}" aria-label="Your decision" data-above-fold="actions">
<input type="hidden" name="t" value="${escapeHtml(options.token)}">
<details class="note"><summary>Add a message for ${member}</summary>
<label for="note">Your message (optional). It is read to them together with your decision.</label>
<textarea id="note" name="note" maxlength="500" rows="2"></textarea>
</details>
${trust}
<div class="actions${view.can_approve ? '' : ' single'}">${approve}<button class="deny" type="submit" name="decision" value="deny">Deny</button></div>
</form>`;
  } else {
    const note = view.decision?.note ? `<p>Note: ${escapeHtml(view.decision.note)}</p>` : '';
    // Straight after pressing a button: what happens next, in the same sentence rather than in a second banner.
    const next = !options.justDecided ? '' : view.status === 'approved' ? ` ${member} will be told.` : view.status === 'denied' ? ` Nothing will be paid, and ${member} will be told.` : '';
    decision = `<section class="card decided" aria-labelledby="decision-h" data-above-fold="decision"><h2 id="decision-h">Decision</h2><p role="status">${decisionLine(view)}${next}</p>${note}</section>`;
  }

  // --- under "Details": nothing here has to be read before deciding ------------
  const signals =
    view.risk_signals.length === 0
      ? ''
      : `<section class="card" aria-labelledby="signs-h"><h2 id="signs-h">Warning signs</h2><ul class="signals">${view.risk_signals
          .map(
            (s) =>
              `<li><strong>${escapeHtml(s.label)}</strong> <span class="tag ${s.severity === 'high' ? 'stop' : 'caution'}">${s.severity}</span><p>${escapeHtml(s.why)}</p>` +
              `<blockquote>&ldquo;${escapeHtml(s.source.quote)}&rdquo;<cite>${escapeHtml(s.source.publisher)}, ${escapeHtml(s.source.title)} ${sourceLink(s.source)}</cite></blockquote></li>`,
          )
          .join('')}</ul></section>`;

  const official = view.payee.official;
  const officialBlock = official
    ? `<dl class="facts">${row('Official name', escapeHtml(official.name))}${row('Official website', escapeHtml(official.website))}${row(
        'Official phone',
        official.phones.map((p) => `${escapeHtml(p.number)} (${escapeHtml(p.label)})`).join('<br>') || undefined,
      )}${row('Accepts', official.accepted_methods.map(methodName).map(escapeHtml).join(', ') || undefined)}${row(
        'Never takes',
        official.never_methods.map(methodName).map(escapeHtml).join(', ') || undefined,
      )}</dl>`
    : '';
  const mismatches =
    view.payee.mismatches.length === 0
      ? ''
      : `<ul>${view.payee.mismatches
          .map((m) => `<li>${escapeHtml(m.detail)}${m.source ? `<blockquote>&ldquo;${escapeHtml(m.source.quote)}&rdquo;<cite>${sourceLink({ ...m.source, publisher: view.payee.name })}</cite></blockquote>` : ''}</li>`)
          .join('')}</ul>`;

  const untrusted = view.untrusted_contact_details;
  // Shown as struck-through text for context. Never a link.
  const untrustedBlock =
    untrusted.claimed_phone || untrusted.claimed_url
      ? `<section class="card stop" aria-labelledby="untrusted-h"><h2 id="untrusted-h">Details from the caller or message</h2><p>${escapeHtml(untrusted.warning)}</p><dl class="facts">${row(
          'Phone given',
          untrusted.claimed_phone ? `<span class="untrusted">${escapeHtml(untrusted.claimed_phone)}</span>` : undefined,
        )}${row('Link given', untrusted.claimed_url ? `<span class="untrusted">${escapeHtml(untrusted.claimed_url)}</span>` : undefined)}</dl></section>`
      : '';

  const details = `<details class="more"><summary>Details</summary>
<section class="card" aria-labelledby="words-h"><h2 id="words-h">In ${member}&rsquo;s words</h2><blockquote>${escapeHtml(view.member_words)}</blockquote><p class="small">Asked ${escapeHtml(new Date(view.created_at).toUTCString())}</p></section>
${signals}
<section class="card" aria-labelledby="payee-h"><h2 id="payee-h">About the payee</h2><p>${escapeHtml(view.payee.note)}</p>${mismatches}${officialBlock}</section>
${untrustedBlock}
</details>`;

  const body = `
${options.error ? `<div class="card banner stop" role="alert"><p>${escapeHtml(options.error)}</p></div>` : ''}
${summary}
${decision}
${details}`;
  return page(`${view.member.name}: payment request`, body);
}
