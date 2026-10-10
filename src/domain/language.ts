/**
 * Every sentence Hold On says to a person lives here.
 *
 * Design principle 4: calm, no-shame language. The older adult is never told
 * they were foolish or "nearly scammed"; the request is the problem, not the
 * person. Design principle 2: these builders only ever receive registry facts
 * and Hold On's own wording, never the phone number or link from the message.
 */
import { formatUsd, methodLabel } from './text.js';
import type {
  HoldStatus,
  OfficialInfo,
  PayeeResult,
  PaymentMethod,
  PolicyDecision,
  RiskSignal,
  Verdict,
} from './types.js';

export const SIMULATED_NOTE = 'This is a demonstration: the payment is simulated and no real money moves.';

/** The line under every card and under the approval page. The cards carry the same sentence (ui/shared.js). */
export const SIMULATED_FOOTER = 'Demonstration only: payments are simulated and no real money moves.';

function officialContactLine(official: OfficialInfo | undefined): string {
  if (!official) return '';
  const phone = official.phones[0];
  if (phone) {
    return ` If you would like to check with the real ${official.name}, the number on their official website is ${phone.number}.`;
  }
  return ` If you would like to check with the real ${official.name}, their official website is ${official.website}.`;
}

function firstName(name: string | undefined): string | undefined {
  return name?.trim().split(/\s+/)[0];
}

export interface CheckLanguageInput {
  verdict: Verdict;
  signals: RiskSignal[];
  payee: PayeeResult;
  policy: PolicyDecision;
  amount_usd?: number;
  contactName?: string;
  notifyOnStop: boolean;
  /** The reason a verified payee still needs approval: `amount_missing` or `over_limit`. */
  approvalCause?: 'amount_missing' | 'over_limit';
}

export function sayCheck(input: CheckLanguageInput): string {
  const contact = firstName(input.contactName);
  const official = input.payee.official;
  const high = input.signals.find((s) => s.severity === 'high');
  const medium = input.signals.find((s) => s.severity === 'medium');
  const hardMismatch = input.payee.mismatches.find((m) => m.severity === 'high');
  const softMismatch = input.payee.mismatches.find((m) => m.severity === 'medium');

  if (input.verdict === 'stop') {
    const reason = high?.why ?? hardMismatch?.detail ?? input.policy.blocked_reasons[0] ?? '';
    const family =
      contact && input.notifyOnStop ? ` I can let ${contact} know, so the two of you can talk it over.` : '';
    return (
      `Let's pause here. I won't send any money for this. ${reason} ` +
      `You did the right thing by checking; requests like this are made to feel urgent.` +
      family +
      officialContactLine(official)
    ).trim();
  }

  if (input.verdict === 'hold_for_family') {
    const reason = medium?.why ?? softMismatch?.detail ?? '';
    const family = contact
      ? ` Before any money moves, I'd like ${contact} to take a look.`
      : ' Before any money moves, it would be good to talk it over with someone you trust.';
    return (`Let's take this one slowly. ${reason}` + family + officialContactLine(official)).trim();
  }

  if (input.verdict === 'verified') {
    const name = input.payee.name ?? 'This payee';
    const basis =
      input.payee.status === 'family_trusted'
        ? `${name} is a payee your family has already confirmed.`
        : `${name} is on my list of official payees.`;
    if (!input.policy.requires_family_approval) {
      return `${basis} This is within what you can pay on your own, so I can take care of it when you are ready. ${SIMULATED_NOTE}`;
    }
    if (input.approvalCause === 'amount_missing') {
      return `${basis} I don't have an amount yet, so ${contact ? `I'll check with ${contact} before anything is paid` : 'nothing will be paid for now'}.`;
    }
    return contact
      ? `${basis} Because of the amount, ${contact} gets a quick request to approve it first. Nothing is paid until then.`
      : `${basis} Because of the amount, it needs a second look before anything is paid.`;
  }

  const name = input.payee.name ? `"${input.payee.name}"` : 'this payee';
  const family = contact
    ? ` To be on the safe side, I'll ask ${contact} to take a look before any money moves.`
    : ' It would be good to talk it over with someone you trust before paying.';
  return `I couldn't find ${name} on my list of official payees, so I can't confirm who they are. That doesn't mean anything is wrong; my list is short.${family}`;
}

export function sayVerifyPayee(payee: PayeeResult): string {
  if (payee.status === 'verified') {
    return `${payee.note}${officialContactLine(payee.official)}`.trim();
  }
  if (payee.status === 'family_trusted') return payee.note;
  if (payee.status === 'mismatch') {
    const details = payee.mismatches.map((m) => m.detail).join(' ');
    return `${payee.note} ${details}${officialContactLine(payee.official)}`.trim();
  }
  return payee.note;
}

export interface HoldLanguageInput {
  status: HoldStatus;
  blocked: boolean;
  contactName?: string;
  deciderName?: string;
  note?: string;
  payeeName?: string;
  amount_usd?: number;
  expiresAt?: string;
}

function describePayment(input: { payeeName?: string; amount_usd?: number }): string {
  const amount = input.amount_usd !== undefined ? formatUsd(input.amount_usd) : undefined;
  if (amount && input.payeeName) return `the ${amount} payment to ${input.payeeName}`;
  if (amount) return `the ${amount} payment`;
  if (input.payeeName) return `the payment to ${input.payeeName}`;
  return 'this payment';
}

export function sayHoldPlaced(input: HoldLanguageInput): string {
  const contact = firstName(input.contactName) ?? 'your trusted contact';
  if (input.blocked) {
    return `Nothing has been paid, and nothing will be. I've let ${contact} know about this request so you can talk it over together. There's no rush.`;
  }
  return `I've put ${describePayment(input)} on hold and let ${contact} know. Nothing has been paid. I'll tell you as soon as ${contact} answers.`;
}

export function sayHoldStatus(input: HoldLanguageInput): string {
  const contact = firstName(input.contactName) ?? 'your trusted contact';
  const decider = firstName(input.deciderName) ?? contact;
  const note = input.note ? ` ${decider} added a note: "${input.note}"` : '';
  switch (input.status) {
    case 'pending_family':
      return input.blocked
        ? `${contact} has been told about this request and hasn't answered yet. Nothing has been paid, and this one won't be paid through me.`
        : `${contact} hasn't answered yet. Nothing has been paid, and ${describePayment(input)} stays on hold until then.`;
    case 'approved':
      return `${decider} said yes to ${describePayment(input)}.${note} I can make the payment whenever you're ready.`;
    case 'denied':
      return `${decider} looked at this and asked that it not be paid.${note} Nothing has been paid. If you'd like, the two of you can talk it over.`;
    case 'expired':
      return `No one answered in time, so the hold on ${describePayment(input)} has ended. Nothing was paid. I can ask again if you'd like.`;
    case 'paid':
      return `${describePayment(input).replace(/^the /, 'The ')} has been made. ${SIMULATED_NOTE}`;
    case 'cancelled':
      return `The hold on ${describePayment(input)} was cancelled. Nothing was paid.`;
  }
}

export function sayPaid(input: { payeeName: string; amount_usd: number; method: PaymentMethod; confirmation: string }): string {
  return `Done. ${formatUsd(input.amount_usd)} was paid to ${input.payeeName} by ${methodLabel(input.method)}. The confirmation code is ${input.confirmation}. ${SIMULATED_NOTE}`;
}

export function sayDecision(input: {
  decision: 'approve' | 'deny';
  memberName: string;
  payeeName?: string;
  amount_usd?: number;
  trustedPayee?: boolean;
}): string {
  const member = firstName(input.memberName) ?? input.memberName;
  if (input.decision === 'approve') {
    const trusted = input.trustedPayee && input.payeeName ? ` ${input.payeeName} is now a confirmed payee for the family.` : '';
    return `Approved. ${member} can now go ahead with ${describePayment(input)}.${trusted}`;
  }
  return `Denied. ${describePayment(input).replace(/^the /, 'The ')} will not be made, and ${member} will be told. A short call to talk it through can help.`;
}

export function sayInbox(count: number, memberName?: string): string {
  const member = firstName(memberName) ?? 'your family member';
  if (count === 0) return `There is nothing waiting for your decision. ${member} has no open requests.`;
  return count === 1
    ? `One request from ${member} is waiting for your decision.`
    : `${count} requests from ${member} are waiting for your decision.`;
}

/** The single clarifying question Hold On may ask through MCP elicitation. */
export const CLARIFYING_QUESTIONS = {
  contact_channel: {
    message:
      'One quick question to help keep this safe: how did this request to pay reach you? There is no wrong answer.',
    title: 'How did the request reach you?',
    options: [
      { const: 'phone_call', title: 'Someone called me' },
      { const: 'text', title: 'I got a text message' },
      { const: 'email', title: 'I got an email' },
      { const: 'mail', title: 'A letter or bill came in the mail' },
      { const: 'in_person', title: 'Someone came in person' },
      { const: 'website', title: 'A website or pop-up' },
      { const: 'unknown', title: "It's my own idea, or I'm not sure" },
    ],
  },
  payment_method: {
    message: 'One quick question to help keep this safe: how were you asked to pay? There is no wrong answer.',
    title: 'How were you asked to pay?',
    options: [
      { const: 'card', title: 'Credit or debit card' },
      { const: 'bank_transfer', title: 'From my bank account' },
      { const: 'check', title: 'Check or money order' },
      { const: 'cash', title: 'Cash' },
      { const: 'gift_card', title: 'Gift cards or a prepaid card' },
      { const: 'wire', title: 'Wire transfer' },
      { const: 'zelle', title: 'Zelle' },
      { const: 'payment_app', title: 'A payment app such as Venmo, Cash App or PayPal' },
      { const: 'crypto', title: 'Bitcoin or a crypto ATM' },
      { const: 'unknown', title: "I'm not sure" },
    ],
  },
} as const;
