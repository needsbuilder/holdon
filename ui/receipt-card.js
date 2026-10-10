// Receipt card for a simulated payment.
import { el, facts, methodName, start, usd, when } from './shared.js';

function render(root, receipt) {
  const details = facts([
    ['Paid with', methodName(receipt.method)],
    ['Confirmation', receipt.confirmation],
    ['When', receipt.paid_at ? when(receipt.paid_at) : undefined],
    ['Receipt', receipt.receipt_id, 'code'],
  ]);
  details.setAttribute('data-above-fold', 'details');
  root.append(
    el(
      'section',
      { class: 'card good', 'aria-labelledby': 'title' },
      el('p', { class: 'eyebrow' }, 'Hold On receipt'),
      el('h1', { id: 'title', 'data-above-fold': 'paid' }, `${usd(receipt.amount_usd) ?? 'Payment'} paid`),
      el('p', { class: 'lead', 'data-above-fold': 'payee' }, `To ${receipt.payee}`),
      el('p', { class: 'badge', 'data-above-fold': 'simulated' }, 'SIMULATED PAYMENT'),
      details,
    ),
  );
}

start('holdon-receipt-card', render);
