// Hold card for the older adult's screen.
//
// Large type, one clear status, and nothing to tap except "check for an
// answer". It never shows a phone number or link from the suspicious message:
// the server already removed them from this person's view, and this card adds
// no links of its own.
import { el, facts, start, usd, when } from './shared.js';

const HEADLINES = {
  pending_family: ['On hold', 'Waiting for an answer. Nothing has been paid.'],
  approved: ['Approved', 'Ready to pay when you are.'],
  denied: ['Not approved', 'Nothing has been paid.'],
  expired: ['Hold ended', 'Nobody answered in time. Nothing was paid.'],
  paid: ['Paid', 'This payment has been made (simulated).'],
  cancelled: ['Cancelled', 'Nothing was paid.'],
};
const TONES = { pending_family: 'caution', approved: 'good', denied: 'stop', expired: 'neutral', paid: 'good', cancelled: 'neutral' };

function render(root, hold, api) {
  const [title, subtitle] = HEADLINES[hold.status] ?? ['Hold', ''];
  const stopped = hold.blocked && hold.status === 'pending_family';
  const card = el(
    'section',
    { class: `card ${stopped ? 'stop' : (TONES[hold.status] ?? 'neutral')}`, 'aria-labelledby': 'status' },
    el('p', { class: 'eyebrow' }, 'Hold On'),
    el('h1', { id: 'status' }, stopped ? 'Stopped' : title),
    el('p', { class: 'lead' }, stopped ? 'This will not be paid. Your family has been told.' : subtitle),
  );
  if (hold.say_to_user) card.append(el('p', { class: 'say' }, hold.say_to_user));

  const told = (hold.notified ?? []).map((person) => (person.relationship ? `${person.name} (${person.relationship})` : person.name)).join(', ');
  card.append(
    facts([
      ['Amount', usd(hold.amount_usd)],
      ['To', hold.payee_name],
      ['Asked', hold.created_at ? when(hold.created_at) : undefined],
      ['Told', told || undefined],
      ['Answered by', hold.decision?.by],
      ['Their note', hold.decision?.note],
    ]),
  );

  if (hold.status === 'pending_family' && hold.hold_id) {
    const status = el('p', { class: 'small', role: 'status' });
    const button = el(
      'button',
      {
        type: 'button',
        class: 'secondary',
        onclick: async () => {
          button.disabled = true;
          status.textContent = 'Checking...';
          try {
            api.show(await api.call('holdon_get_hold', { hold_id: hold.hold_id }));
          } catch {
            button.disabled = false;
            status.textContent = 'Could not check just now. Please try again in a moment.';
          }
        },
      },
      'Check for an answer',
    );
    card.append(el('div', { class: 'actions' }, button), status);
  }
  root.append(card);
}

start('holdon-hold-card', render);
