// Approval card for the trusted contact.
//
// Built for a phone: who is asking, how much and to whom, the verdict in a few
// words and the Approve / Deny buttons all fit on the first screen. A stopped
// request shows, in the same place, that it cannot be approved and why, one
// reason per line with its official source. Everything else is under "Details".
//
// The buttons call the `holdon_family_decide` tool through the host, so the
// server applies exactly the same rules as for any other caller: a stopped
// request cannot be approved, and an unknown payee needs an explicit vouch.
import { channelName, el, facts, methodName, sourceLink, start, textOf, usd, when } from './shared.js';

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

/** The reasons to list. Older servers do not send `reasons`; fall back to the warning signs they do send. */
function reasonsOf(hold) {
  if (Array.isArray(hold.reasons)) return hold.reasons;
  return (hold.risk_signals ?? []).map((signal) => ({ kind: 'scam_pattern', blocking: signal.severity === 'high', text: signal.label, source: signal.source }));
}

/**
 * One reason: its text as given, and its source. When the text already names
 * the source's website ("...official site, irs.gov."), that mention becomes the
 * link; otherwise the website follows the text. Either way it is shown once.
 */
function reasonItem(reason, api) {
  const mention = reason.source?.named_in_text;
  const at = mention ? reason.text.indexOf(mention) : -1;
  if (at >= 0) return el('li', {}, reason.text.slice(0, at), sourceLink(reason.source, api, mention), reason.text.slice(at + mention.length));
  return el('li', {}, reason.text, reason.source ? ' ' : undefined, sourceLink(reason.source, api));
}

/** One reason per item, each with its source where the data has one. */
function reasonList(reasons, api) {
  return el(
    'ul',
    { class: 'reasons', 'data-above-fold': 'reasons' },
    reasons.map((reason) => reasonItem(reason, api)),
  );
}

/**
 * What is true of the request right now, in a few words, next to the verdict.
 * A stopped request is not "waiting for a decision": nothing will be paid
 * whatever is pressed. A request that is no longer open says nothing here; the
 * decision box below says it once.
 */
function stateOf(hold) {
  if (hold.status !== 'pending_family') return undefined;
  return hold.blocked ? 'Nothing will be paid' : STATUS.pending_family;
}

function summary(hold, api) {
  const [verdictLabel, tone] = VERDICTS[hold.verdict] ?? ['Request', 'neutral'];
  const reasons = reasonsOf(hold);
  // A stopped request leads with what stops it; anything else shows every warning sign.
  const listed = hold.blocked ? reasons.filter((reason) => reason.blocking) : reasons;
  const meta = [methodName(hold.payment_method), channelName(hold.contact_channel), hold.secrecy_requested ? 'Told to keep it secret' : undefined].filter(Boolean).join(' · ');
  const open = hold.status === 'pending_family';

  const card = el(
    'section',
    { class: `card summary ${hold.blocked ? 'stop' : tone}`, 'aria-labelledby': 'who' },
    el('p', { class: 'eyebrow' }, 'Hold On · simulated payments'),
    el('h1', { id: 'who', 'data-above-fold': 'who' }, `${hold.member.name} asked to make a payment`),
    el('p', { class: 'amount', 'data-above-fold': 'amount' }, usd(hold.amount_usd) ?? 'No amount given', el('span', { class: 'to' }, ' to '), hold.payee_name ?? 'no payee named'),
    el('p', { class: 'meta' }, meta),
    el('p', { class: 'verdict', 'data-above-fold': 'verdict' }, el('span', { class: `tag ${hold.blocked ? 'stop' : tone}` }, verdictLabel), stateOf(hold) ? el('span', { class: 'state' }, stateOf(hold)) : undefined),
  );

  if (hold.blocked) {
    card.append(el('p', { class: 'cannot', 'data-above-fold': 'cannot-approve' }, el('strong', {}, 'This request cannot be approved.')));
    if (listed.length > 0) card.append(el('h2', { class: 'list-title' }, 'Why it was stopped'), reasonList(listed, api));
  } else {
    if (open && !hold.can_approve && hold.cannot_approve_reason) {
      card.append(el('p', { class: 'cannot', 'data-above-fold': 'cannot-approve' }, el('strong', {}, 'This request cannot be approved. '), hold.cannot_approve_reason));
    }
    if (listed.length > 0) card.append(el('h2', { class: 'list-title' }, 'Warning signs'), reasonList(listed, api));
    else card.append(el('p', { class: 'calm' }, 'No known scam pattern matched this request.'));
  }
  return card;
}

function decisionForm(hold, api, onDecided) {
  const section = el('section', { class: 'decide', 'aria-label': 'Your decision', 'data-above-fold': 'actions' });
  const note = el('textarea', { id: 'note', maxlength: 500, rows: 2 });
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

  section.append(
    el(
      'details',
      { class: 'note' },
      el('summary', {}, `Add a message for ${hold.member.name}`),
      el('label', { for: 'note', class: 'small' }, 'Optional. It is read to them together with your decision.'),
      note,
    ),
  );
  if (trust) {
    section.append(
      el('label', { class: 'check', for: 'trust' }, trust, el('span', {}, `I personally know and trust ${hold.payee_name ?? 'this payee'}. Hold On could not find them in its registry of official payees. (Needed to approve.)`)),
    );
  }
  const actions = el('div', { class: hold.can_approve ? 'actions' : 'actions single' });
  if (hold.can_approve) {
    const approve = el('button', { type: 'button', class: 'approve', onclick: () => decide('approve') }, 'Approve');
    buttons.push(approve);
    actions.append(approve);
  }
  const deny = el('button', { type: 'button', class: 'deny', onclick: () => decide('deny') }, 'Deny');
  buttons.push(deny);
  actions.append(deny);
  section.append(actions, feedback);
  return section;
}

/** Everything that does not have to be read before deciding. */
function details(hold, api) {
  const more = el('details', { class: 'more' }, el('summary', {}, 'Details'));
  more.append(el('section', { class: 'card', 'aria-labelledby': 'words-h' }, el('h2', { id: 'words-h' }, `In ${hold.member.name}'s words`), el('blockquote', {}, hold.member_words), el('p', { class: 'small' }, `Asked ${when(hold.created_at) ?? ''}`)));

  if (hold.risk_signals?.length) {
    more.append(
      el(
        'section',
        { class: 'card', 'aria-labelledby': 'signs-h' },
        el('h2', { id: 'signs-h' }, 'Warning signs'),
        el(
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
              // Official guidance, quoted.
              el('blockquote', {}, `"${signal.source.quote}"`, el('cite', {}, `${signal.source.publisher}, ${signal.source.title} `, sourceLink(signal.source, api))),
            ),
          ),
        ),
      ),
    );
  }

  const info = hold.payee ?? {};
  const payee = el('section', { class: 'card', 'aria-labelledby': 'payee-h' }, el('h2', { id: 'payee-h' }, 'About the payee'), el('p', {}, info.note ?? ''));
  if (info.mismatches?.length) {
    payee.append(
      el(
        'ul',
        {},
        info.mismatches.map((m) => el('li', {}, m.detail, m.source ? el('blockquote', {}, `"${m.source.quote}"`, el('cite', {}, sourceLink({ ...m.source, publisher: info.name }, api))) : undefined)),
      ),
    );
  }
  if (info.official) {
    payee.append(
      facts([
        ['Official name', info.official.name],
        ['Official website', info.official.website],
        ['Official phone', info.official.phones.map((p) => `${p.number} (${p.label})`).join('; ')],
        ['Accepts', info.official.accepted_methods.map(methodName).join(', ')],
        ['Never takes', info.official.never_methods.map(methodName).join(', ')],
      ]),
    );
  }
  more.append(payee);

  const untrusted = hold.untrusted_contact_details ?? {};
  if (untrusted.claimed_phone || untrusted.claimed_url) {
    more.append(
      el(
        'section',
        { class: 'card stop', 'aria-labelledby': 'untrusted-h' },
        el('h2', { id: 'untrusted-h' }, 'Details from the caller or message'),
        el('p', {}, untrusted.warning),
        // Shown as struck-through text for context. Never a link.
        facts([
          ['Phone given', untrusted.claimed_phone ? el('span', { class: 'untrusted' }, untrusted.claimed_phone) : undefined],
          ['Link given', untrusted.claimed_url ? el('span', { class: 'untrusted' }, untrusted.claimed_url) : undefined],
        ]),
      ),
    );
  }
  return more;
}

/**
 * What became of a request that is no longer open, said once. Only the trusted
 * contact approves or denies; paying, cancelling and running out of time are
 * things that happened afterwards and are not theirs.
 */
function decisionLine(hold) {
  const by = hold.decision ? ` by ${hold.decision.by}` : '';
  if (hold.status === 'denied') return `Denied${by}.`;
  if (hold.status === 'approved') return `Approved${by}.`;
  const approved = hold.decision ? `Approved${by}. ` : '';
  if (hold.status === 'paid') return `${approved}Paid (simulated).`;
  if (hold.status === 'expired') return hold.decision ? `${approved}Expired before it was paid.` : 'Expired without a decision.';
  if (hold.status === 'cancelled') return `${approved}Cancelled by your family member.`;
  return `${STATUS[hold.status] ?? hold.status}.`;
}

function renderHold(root, hold, api) {
  root.append(summary(hold, api));
  if (hold.status === 'pending_family') {
    root.append(decisionForm(hold, api, (decided) => api.show({ structuredContent: decided, content: [] })));
  } else {
    root.append(
      el(
        'section',
        { class: 'card decided', 'data-above-fold': 'decision' },
        el('h2', {}, 'Decision'),
        el('p', { role: 'status' }, decisionLine(hold)),
        hold.decision?.note ? el('p', {}, `Note: ${hold.decision.note}`) : undefined,
      ),
    );
  }
  root.append(details(hold, api));
}

function render(root, data, api) {
  // After a decision: the result of holdon_family_decide.
  if (data.decision && data.status && !data.member) {
    const approved = data.status === 'approved';
    const headline = approved ? 'Approved' : 'Denied';
    // The server's sentence opens with the same word for the voice; the card says it once, as the headline.
    const said = data.say_to_user ?? '';
    const rest = said.startsWith(`${headline}. `) ? said.slice(headline.length + 2) : said;
    root.append(
      el(
        'section',
        { class: `card summary result ${approved ? 'good' : 'stop'}`, 'data-above-fold': 'decision' },
        el('p', { class: 'eyebrow' }, 'Hold On · simulated payments'),
        el('h1', {}, headline),
        el('p', { class: 'say', role: 'status' }, rest),
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
    root.append(
      el('section', { class: 'card summary result good' }, el('p', { class: 'eyebrow' }, 'Hold On · simulated payments'), el('h1', {}, 'Nothing is waiting'), el('p', { class: 'say', role: 'status' }, data.say_to_user ?? 'There are no requests to decide.')),
    );
    return;
  }
  const waiting = holds.filter((hold) => hold.status === 'pending_family');
  if (waiting.length > 1) root.append(el('p', { class: 'small queue', role: 'status' }, `${waiting.length} requests are waiting. Showing the newest first.`));
  renderHold(root, waiting[0] ?? holds[0], api);
}

start('holdon-approval-card', render);
