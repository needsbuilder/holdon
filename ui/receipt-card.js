// Receipt card for a simulated payment.
import { el, facts, methodName, start, usd, when } from './shared.js';

function render(root, receipt) {
  root.append(
    el(
      'section',
      { class: 'card good', 'aria-labelledby': 'title' },
      el('p', { class: 'eyebrow' }, 'Hold On receipt'),
      el('h1', { id: 'title' }, `${usd(receipt.amount_usd) ?? 'Payment'} paid`),
      el('p', { class: 'lead' }, `To ${receipt.payee}`),
      el('p', { class: 'badge' }, 'SIMULATED PAYMENT'),
      facts([
        ['Paid with', methodName(receipt.method)],
        ['Confirmation', receipt.confirmation],
        ['When', receipt.paid_at ? when(receipt.paid_at) : undefined],
        ['Receipt', receipt.receipt_id],
      ]),
    ),
  );
}

start('holdon-receipt-card', render);
