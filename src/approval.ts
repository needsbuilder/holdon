/**
 * The family approval web page.
 *
 * A trusted contact opens a signed link, reads the full context and presses
 * Approve or Deny. The page is plain server-rendered HTML with no script, so
 * it works in any browser and with a screen reader. The link is a capability:
 * it is only ever handed to the trusted contact, never to the older adult.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SIMULATED_NOTE } from './domain/language.js';
import { channelLabel, formatUsd, methodLabel } from './domain/text.js';
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

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 1.125rem/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; background: #f3f4f6; }
main { max-width: 44rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 0.25rem; }
h2 { font-size: 1.25rem; margin: 0 0 0.5rem; }
p { margin: 0 0 0.75rem; }
.card { background: #ffffff; border: 2px solid #1f2937; border-radius: 0.75rem; padding: 1.25rem; margin: 1rem 0; }
.banner { border-left-width: 0.75rem; }
.stop { border-color: #991b1b; background: #fef2f2; }
.caution { border-color: #92400e; background: #fffbeb; }
.good { border-color: #166534; background: #f0fdf4; }
.tag { display: inline-block; font-weight: 700; padding: 0.1rem 0.6rem; border-radius: 0.4rem; color: #ffffff; background: #1f2937; }
.tag.stop { background: #991b1b; } .tag.caution { background: #92400e; } .tag.good { background: #166534; }
dl { display: grid; grid-template-columns: minmax(8rem, auto) 1fr; gap: 0.35rem 1rem; margin: 0; }
dt { font-weight: 700; } dd { margin: 0; overflow-wrap: anywhere; }
blockquote { margin: 0.5rem 0; padding: 0.5rem 1rem; border-left: 0.3rem solid #4b5563; background: #f9fafb; }
ul { margin: 0; padding-left: 1.25rem; } li { margin-bottom: 0.75rem; }
.untrusted { font-family: ui-monospace, Menlo, Consolas, monospace; background: #fee2e2; padding: 0 0.3rem; overflow-wrap: anywhere; }
label { display: block; font-weight: 700; margin: 0.75rem 0 0.25rem; }
textarea { width: 100%; min-height: 5rem; font: inherit; padding: 0.6rem; border: 2px solid #1f2937; border-radius: 0.5rem; }
.check { display: flex; gap: 0.75rem; align-items: flex-start; font-weight: 400; }
.check input { width: 1.5rem; height: 1.5rem; margin-top: 0.2rem; flex: none; }
.actions { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 1.25rem; }
button { font: inherit; font-weight: 700; min-height: 3.25rem; padding: 0.75rem 1.75rem; border-radius: 0.6rem; border: 2px solid transparent; cursor: pointer; color: #ffffff; }
button.approve { background: #166534; } button.deny { background: #991b1b; }
button:focus-visible, textarea:focus-visible, input:focus-visible, a:focus-visible { outline: 4px solid #1d4ed8; outline-offset: 3px; }
a { color: #1d4ed8; }
.small { font-size: 1rem; color: #374151; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="format-detection" content="telephone=no, email=no, address=no">
<title>${escapeHtml(title)} | Hold On</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<p class="small">Hold On is a hackathon demonstration. ${escapeHtml(SIMULATED_NOTE)}</p>
</main>
</body>
</html>`;
}

export function renderMessagePage(title: string, message: string, tone: 'good' | 'caution' | 'stop' = 'caution'): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><div class="card banner ${tone}" role="status"><p>${escapeHtml(message)}</p></div>`);
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

export function renderApprovalPage(view: FamilyHoldView, options: { token: string; notice?: string; error?: string }): string {
  const tone = view.blocked ? 'stop' : view.risk_signals.length > 0 || view.payee.status === 'mismatch' ? 'caution' : view.payee.status === 'not_in_registry' ? 'caution' : 'good';
  const verdictLabel =
    view.verdict === 'stop'
      ? 'Stopped by Hold On'
      : view.verdict === 'hold_for_family'
        ? 'Warning signs found'
        : view.verdict === 'verified'
          ? 'Confirmed payee'
          : 'Payee could not be confirmed';
  const amount = view.amount_usd !== undefined ? formatUsd(view.amount_usd) : 'No amount given';
  const member = escapeHtml(view.member.name);

  const signals =
    view.risk_signals.length === 0
      ? '<p>No known scam pattern matched this request.</p>'
      : `<ul>${view.risk_signals
          .map(
            (s) =>
              `<li><strong>${escapeHtml(s.label)}</strong> <span class="tag ${s.severity === 'high' ? 'stop' : 'caution'}">${s.severity}</span><br>${escapeHtml(s.why)}` +
              `<blockquote>&ldquo;${escapeHtml(s.source.quote)}&rdquo;<br><span class="small">${escapeHtml(s.source.publisher)}, <a href="${escapeHtml(s.source.url)}" rel="noreferrer noopener">${escapeHtml(s.source.title)}</a></span></blockquote></li>`,
          )
          .join('')}</ul>`;

  const official = view.payee.official;
  const officialBlock = official
    ? `<dl>${row('Official name', escapeHtml(official.name))}${row('Official website', escapeHtml(official.website))}${row(
        'Official phone',
        official.phones.map((p) => `${escapeHtml(p.number)} <span class="small">(${escapeHtml(p.label)})</span>`).join('<br>') || undefined,
      )}${row('Accepts', official.accepted_methods.map(methodLabel).map(escapeHtml).join(', ') || undefined)}${row(
        'Never takes',
        official.never_methods.map(methodLabel).map(escapeHtml).join(', ') || undefined,
      )}</dl>`
    : '';
  const mismatches =
    view.payee.mismatches.length === 0
      ? ''
      : `<ul>${view.payee.mismatches
          .map(
            (m) =>
              `<li>${escapeHtml(m.detail)}${m.source ? `<blockquote>&ldquo;${escapeHtml(m.source.quote)}&rdquo;<br><span class="small"><a href="${escapeHtml(m.source.url)}" rel="noreferrer noopener">Source</a></span></blockquote>` : ''}</li>`,
          )
          .join('')}</ul>`;

  const untrusted = view.untrusted_contact_details;
  const untrustedBlock =
    untrusted.claimed_phone || untrusted.claimed_url
      ? `<section class="card stop" aria-labelledby="untrusted-h"><h2 id="untrusted-h">Details from the caller or message</h2><p>${escapeHtml(untrusted.warning)}</p><dl>${row(
          'Phone given',
          untrusted.claimed_phone ? `<span class="untrusted">${escapeHtml(untrusted.claimed_phone)}</span>` : undefined,
        )}${row('Link given', untrusted.claimed_url ? `<span class="untrusted">${escapeHtml(untrusted.claimed_url)}</span>` : undefined)}</dl></section>`
      : '';

  let decisionBlock: string;
  if (view.status !== 'pending_family') {
    const by = view.decision ? ` by ${escapeHtml(view.decision.by)}` : '';
    const note = view.decision?.note ? `<p>Note: ${escapeHtml(view.decision.note)}</p>` : '';
    decisionBlock = `<section class="card" aria-labelledby="decision-h"><h2 id="decision-h">Decision</h2><p role="status"><strong>${escapeHtml(STATUS_TEXT[view.status] ?? view.status)}</strong>${by}.</p>${note}</section>`;
  } else {
    const trust = view.requires_trust_payee
      ? `<label class="check" for="trust_payee"><input type="checkbox" id="trust_payee" name="trust_payee" value="true"><span>I personally know and trust <strong>${escapeHtml(view.payee_name ?? 'this payee')}</strong>. Hold On could not find them in its registry of official payees. (Needed to approve.)</span></label>`
      : '';
    const approve = view.can_approve
      ? `<button class="approve" type="submit" name="decision" value="approve">Approve</button>`
      : `<p role="note"><strong>This request cannot be approved.</strong> ${escapeHtml(view.cannot_approve_reason ?? '')}</p>`;
    decisionBlock = `<section class="card" aria-labelledby="decision-h"><h2 id="decision-h">Your decision</h2>
<form method="post" action="/approve/${encodeURIComponent(view.hold_id)}">
<input type="hidden" name="t" value="${escapeHtml(options.token)}">
<label for="note">Message for ${member} (optional)</label>
<textarea id="note" name="note" maxlength="500" aria-describedby="note-help"></textarea>
<p id="note-help" class="small">This is read to ${member} together with your decision.</p>
${trust}
<div class="actions">${view.can_approve ? approve : ''}<button class="deny" type="submit" name="decision" value="deny">Deny</button></div>
${view.can_approve ? '' : approve}
</form></section>`;
  }

  const body = `
<h1>${member} asked to make a payment</h1>
<p>${escapeHtml(STATUS_TEXT[view.status] ?? view.status)}. Asked on ${escapeHtml(new Date(view.created_at).toUTCString())}.</p>
${options.notice ? `<div class="card banner good" role="status"><p>${escapeHtml(options.notice)}</p></div>` : ''}
${options.error ? `<div class="card banner stop" role="alert"><p>${escapeHtml(options.error)}</p></div>` : ''}
<section class="card banner ${tone}" aria-labelledby="summary-h">
<h2 id="summary-h">The request <span class="tag ${tone}">${escapeHtml(verdictLabel)}</span></h2>
<dl>
${row('Amount', escapeHtml(amount))}
${row('To', view.payee_name ? escapeHtml(view.payee_name) : 'No payee named')}
${row('How', escapeHtml(methodLabel(view.payment_method)))}
${row('Reached them by', view.contact_channel ? escapeHtml(channelLabel(view.contact_channel)) : undefined)}
${row('Told to keep it secret', view.secrecy_requested ? 'Yes' : undefined)}
</dl>
${view.blocked ? `<p><strong>Hold On will not pay this.</strong> ${escapeHtml(view.blocked_reasons.join(' '))}</p>` : ''}
</section>
<section class="card" aria-labelledby="words-h"><h2 id="words-h">In ${member}&rsquo;s words</h2><blockquote>${escapeHtml(view.member_words).replace(/\n/g, '<br>')}</blockquote></section>
<section class="card" aria-labelledby="signs-h"><h2 id="signs-h">Warning signs</h2>${signals}</section>
<section class="card" aria-labelledby="payee-h"><h2 id="payee-h">About the payee</h2><p>${escapeHtml(view.payee.note)}</p>${mismatches}${officialBlock}</section>
${untrustedBlock}
${decisionBlock}`;
  return page(`${view.member.name}: payment request`, body);
}
