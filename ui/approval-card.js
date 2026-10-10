// Approval card for the trusted contact.
//
// Shows one request with its full context and lets the contact approve or deny
// it. The buttons call the `holdon_family_decide` tool through the host, so the
// server applies exactly the same rules as for any other caller: a stopped
// request cannot be approved, and an unknown payee needs an explicit vouch.
import { channelName, el, facts, methodName, start, textOf, usd, when } from './shared.js';

const VERDICTS = {
  stop: ['Stopped by Hold On', 'stop'],
  hold_for_family: ['Warning signs found', 'caution'],
  verified: ['Confirmed payee', 'good'],
  unknown: ['Payee could not be confirmed', 'caution'],
};
const STATUS = {
  pending_family: 'Waiting for your decision',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired without a decision',
  paid: 'Paid (simulated)',
  cancelled: 'Cancelled by your family member',
};

function signals(hold) {
  if (!hold.risk_signals?.length) return el('p', {}, 'No known scam pattern matched this request.');
  return el(
    'ul',
    { class: 'signals' },
    hold.risk_signals.map((signal) =>
      el(
        'li',
        {},
        el('strong', {}, signal.label),
        ' ',
        el('span', { class: `tag ${signal.severity === 'high' ? 'stop' : 'caution'}` }, signal.severity),
        el('p', {}, signal.why),
        // Official guidance, quoted. Shown as text: this card contains no links at all.
        el('blockquote', {}, `"${signal.source.quote}"`, el('cite', {}, `${signal.source.publisher}, ${signal.source.title}`)),
      ),
    ),
  );
}

function payee(hold) {
  const info = hold.payee ?? {};
  const section = el('section', { class: 'card', 'aria-labelledby': 'payee-h' }, el('h2', { id: 'payee-h' }, 'About the payee'), el('p', {}, info.note ?? ''));
  if (info.mismatches?.length) section.append(el('ul', {}, info.mismatches.map((m) => el('li', {}, m.detail))));
  if (info.official) {
    section.append(
      facts([
        ['Official name', info.official.name],
        ['Official website', info.official.website],
        ['Official phone', info.official.phones.map((p) => `${p.number} (${p.label})`).join('; ')],
        ['Never takes', info.official.never_methods.map(methodName).join(', ')],
      ]),
    );
  }
  return section;
}

function untrusted(hold) {
  const details = hold.untrusted_contact_details ?? {};
  if (!details.claimed_phone && !details.claimed_url) return undefined;
  return el(
    'section',
    { class: 'card stop', 'aria-labelledby': 'untrusted-h' },
    el('h2', { id: 'untrusted-h' }, 'Details from the caller or message'),
    el('p', {}, details.warning),
    facts([
      ['Phone given', details.claimed_phone ? el('span', { class: 'untrusted' }, details.claimed_phone) : undefined],
      ['Link given', details.claimed_url ? el('span', { class: 'untrusted' }, details.claimed_url) : undefined],
    ]),
  );
}

function decisionForm(hold, api, onDecided) {
  const section = el('section', { class: 'card', 'aria-labelledby': 'decide-h' }, el('h2', { id: 'decide-h' }, 'Your decision'));
  const note = el('textarea', { id: 'note', maxlength: 500, rows: 3 });
  const trust = hold.requires_trust_payee ? el('input', { type: 'checkbox', id: 'trust' }) : undefined;
  const feedback = el('p', { role: 'alert', class: 'feedback' });
  const buttons = [];

  async function decide(decision) {
    buttons.forEach((button) => (button.disabled = true));
    feedback.textContent = '';
    const args = { hold_id: hold.hold_id, decision };
    if (note.value.trim()) args.note = note.value.trim();
    if (decision === 'approve' && trust?.checked) args.trust_payee = true;
    try {
      const result = await api.call('holdon_family_decide', args);
      if (result.isError) {
        feedback.textContent = textOf(result).replace(/^Error \([a-z_]+\):\s*/, '');
        buttons.forEach((button) => (button.disabled = false));
        return;
      }
      onDecided(result.structuredContent);
    } catch {
      feedback.textContent = 'The decision could not be sent. Please try again.';
      buttons.forEach((button) => (button.disabled = false));
    }
  }

  section.append(el('label', { for: 'note' }, `Message for ${hold.member.name} (optional)`), note);
  if (trust) {
    section.append(
      el('label', { class: 'check', for: 'trust' }, trust, el('span', {}, `I personally know and trust ${hold.payee_name ?? 'this payee'}. Hold On could not find them in its registry of official payees. (Needed to approve.)`)),
    );
  }
  const actions = el('div', { class: 'actions' });
  if (hold.can_approve) {
    const approve = el('button', { type: 'button', class: 'approve', onclick: () => decide('approve') }, 'Approve');
    buttons.push(approve);
    actions.append(approve);
  }
  const deny = el('button', { type: 'button', class: 'deny', onclick: () => decide('deny') }, 'Deny');
  buttons.push(deny);
  actions.append(deny);
  section.append(actions);
  if (!hold.can_approve && hold.cannot_approve_reason) {
    section.append(el('p', { role: 'note' }, el('strong', {}, 'This request cannot be approved. '), hold.cannot_approve_reason));
  }
  section.append(feedback);
  return section;
}

function renderHold(root, hold, api) {
  const [verdictLabel, tone] = VERDICTS[hold.verdict] ?? ['Request', 'neutral'];
  root.append(
    el('h1', {}, `${hold.member.name} asked to make a payment`),
    el('p', { class: 'lead' }, `${STATUS[hold.status] ?? hold.status}. Asked ${when(hold.created_at) ?? ''}.`),
    el(
      'section',
      { class: `card ${hold.blocked ? 'stop' : tone}`, 'aria-labelledby': 'request-h' },
      el('h2', { id: 'request-h' }, 'The request ', el('span', { class: `tag ${hold.blocked ? 'stop' : tone}` }, verdictLabel)),
      facts([
        ['Amount', usd(hold.amount_usd) ?? 'No amount given'],
        ['To', hold.payee_name ?? 'No payee named'],
        ['How', methodName(hold.payment_method)],
        ['Reached them by', channelName(hold.contact_channel)],
        ['Told to keep it secret', hold.secrecy_requested ? 'Yes' : undefined],
      ]),
      hold.blocked ? el('p', {}, el('strong', {}, 'Hold On will not pay this. '), (hold.blocked_reasons ?? []).join(' ')) : undefined,
    ),
    el('section', { class: 'card', 'aria-labelledby': 'words-h' }, el('h2', { id: 'words-h' }, `In ${hold.member.name}'s words`), el('blockquote', {}, hold.member_words)),
    el('section', { class: 'card', 'aria-labelledby': 'signs-h' }, el('h2', { id: 'signs-h' }, 'Warning signs'), signals(hold)),
    payee(hold),
    untrusted(hold),
  );
  if (hold.status === 'pending_family') {
    root.append(
      decisionForm(hold, api, (decided) => {
        api.show({ structuredContent: decided, content: [] });
      }),
    );
  } else if (hold.decision) {
    root.append(el('section', { class: 'card' }, el('h2', {}, 'Decision'), el('p', { role: 'status' }, `${STATUS[hold.status] ?? hold.status} by ${hold.decision.by}.`)));
  }
}

function render(root, data, api) {
  // After a decision: the result of holdon_family_decide.
  if (data.decision && data.status && !data.member) {
    const approved = data.status === 'approved';
    root.append(
      el(
        'section',
        { class: `card ${approved ? 'good' : 'stop'}` },
        el('h1', {}, approved ? 'Approved' : 'Denied'),
        el('p', { class: 'lead', role: 'status' }, data.say_to_user ?? ''),
        facts([
          ['Decided by', data.decision.by],
          ['Your note', data.decision.note],
        ]),
      ),
    );
    return;
  }
  // A single hold, or the inbox: show the first one still waiting, else the newest.
  const holds = data.holds ?? [data];
  if (holds.length === 0) {
    root.append(el('section', { class: 'card good' }, el('h1', {}, 'Nothing is waiting'), el('p', { class: 'lead', role: 'status' }, data.say_to_user ?? 'There are no requests to decide.')));
    return;
  }
  const waiting = holds.filter((hold) => hold.status === 'pending_family');
  if (waiting.length > 1) root.append(el('p', { class: 'small', role: 'status' }, `${waiting.length} requests are waiting. Showing the newest first.`));
  renderHold(root, waiting[0] ?? holds[0], api);
}

start('holdon-approval-card', render);
