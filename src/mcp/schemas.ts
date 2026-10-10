/**
 * Input and output schemas for every Hold On tool.
 *
 * These zod schemas are what the MCP SDK turns into the JSON Schema that
 * clients see in `tools/list`, so the descriptions here are the tool contract.
 */
import { z } from 'zod';
import {
  CONTACT_CHANNELS,
  HOLD_STATUSES,
  NEXT_STEPS,
  PAYEE_CATEGORIES,
  PAYEE_STATUSES,
  PAYMENT_METHODS,
  SEVERITIES,
  URGENCY_CLAIMS,
  VERDICTS,
} from '../domain/types.js';

const paymentMethod = z
  .enum(PAYMENT_METHODS)
  .describe(
    'How the money would be paid. gift_card includes prepaid and reloadable cards; payment_app means Venmo, Cash App, PayPal and similar; bank_transfer means paying from a checking or savings account; card means a credit or debit card.',
  );
const contactChannel = z
  .enum(CONTACT_CHANNELS)
  .describe('How the person asking for money reached the user. Leave it out when paying is the user\'s own idea.');
const holdId = z.string().trim().regex(/^hold_[A-Za-z0-9_-]+$/, 'hold_id looks like "hold_..." and comes from holdon_place_hold or holdon_list_holds.');
const checkId = z.string().trim().regex(/^chk_[A-Za-z0-9_-]+$/, 'check_id looks like "chk_..." and comes from holdon_check_request.');
const amountUsd = z
  .number('amount_usd must be a number of US dollars, for example 182.4.')
  .positive('amount_usd must be greater than zero.')
  .max(1_000_000, 'amount_usd must be 1,000,000 or less.')
  .describe('Amount in US dollars, for example 182.4.');

// --- shared output pieces ---------------------------------------------------

const riskSignal = z.object({
  id: z.string(),
  label: z.string(),
  severity: z.enum(SEVERITIES),
  why: z.string().describe('Plain-language reason, safe to read aloud.'),
  matched_on: z.array(z.string()).describe('Which inputs triggered the rule.'),
  source: z
    .object({ publisher: z.string(), title: z.string(), url: z.string(), quote: z.string() })
    .describe('The official guidance this rule is based on, with a verbatim quote.'),
});

const mismatch = z.object({
  field: z.enum(['url', 'phone', 'address', 'payment_method', 'contact_channel', 'payment_request']),
  code: z.string(),
  severity: z.enum(SEVERITIES),
  detail: z.string(),
  fact: z.string().optional().describe("The registry's own one-line statement of the official fact behind this mismatch, verbatim. Absent for a plain comparison such as a phone number that is not on file."),
  source: z.object({ url: z.string(), quote: z.string() }).optional(),
});

const reason = z.object({
  kind: z.enum(['scam_pattern', 'official_fact', 'policy']),
  blocking: z.boolean().describe('True when this reason alone is enough to stop the request.'),
  text: z.string().describe('A pattern label from the rules file, a fact summary from the registry, a registry comparison, or a policy sentence. One reason per item.'),
  source: z
    .object({
      publisher: z.string(),
      title: z.string().optional(),
      url: z.string(),
      quote: z.string(),
      named_in_text: z.string().optional().describe("Set when `text` already names the source's website: show that mention as the link, and the website only once."),
    })
    .optional(),
});

const official = z
  .object({
    name: z.string(),
    category: z.enum(PAYEE_CATEGORIES),
    website: z.string(),
    phones: z.array(z.object({ label: z.string(), number: z.string(), source_url: z.string() })),
    accepted_methods: z.array(z.enum(PAYMENT_METHODS)),
    never_methods: z.array(z.enum(PAYMENT_METHODS)),
  })
  .describe('Registry-verified official details. These are the only contact details that may be read to the user.');

const payee = z.object({
  status: z
    .enum(PAYEE_STATUSES)
    .describe('verified: in the official registry and nothing supplied conflicts. family_trusted: vouched for by the trusted contact. mismatch: in the registry but a supplied detail conflicts. not_in_registry: unknown to Hold On.'),
  name: z.string().optional(),
  registry_id: z.string().optional(),
  category: z.enum(PAYEE_CATEGORIES).optional(),
  official: official.optional(),
  matches: z.array(z.string()),
  mismatches: z.array(mismatch),
  note: z.string(),
});

const policyDecision = z.object({
  requires_family_approval: z.boolean(),
  reason: z.string(),
  blocked: z.boolean().describe('True when this payment cannot be approved or paid at all.'),
  blocked_reasons: z.array(z.string()),
});

const decision = z.object({
  by: z.string().describe('Name of the trusted contact who decided, or "Family policy" for automatic approval.'),
  at: z.string().describe('ISO 8601 time.'),
  note: z.string().optional(),
});

const receipt = z.object({
  receipt_id: z.string(),
  hold_id: z.string(),
  amount_usd: z.number(),
  payee: z.string(),
  method: z.enum(PAYMENT_METHODS),
  confirmation: z.string(),
  paid_at: z.string(),
  simulated: z.literal(true).describe('Always true: Hold On never moves real money.'),
});

const holdCore = {
  hold_id: z.string(),
  check_id: z.string(),
  status: z.enum(HOLD_STATUSES),
  summary: z.string(),
  amount_usd: z.number().optional(),
  payee_name: z.string().optional(),
  payment_method: z.enum(PAYMENT_METHODS),
  verdict: z.enum(VERDICTS),
  payee_status: z.enum(PAYEE_STATUSES),
  blocked: z.boolean().describe('True when the request was stopped: the trusted contact can only deny it and it can never be paid.'),
  blocked_reasons: z.array(z.string()),
  created_at: z.string(),
  expires_at: z.string(),
  decision: decision.optional(),
  receipt: receipt.optional(),
};

const memberHold = z.object({
  ...holdCore,
  say_to_user: z.string().describe('A calm sentence the assistant can say as is.'),
  next_step: z.enum(['wait', 'pay', 'none']),
});

const familyHold = z.object({
  ...holdCore,
  member: z.object({ id: z.string(), name: z.string() }),
  member_words: z.string().describe("The family member's own description of the request."),
  contact_channel: z.enum(CONTACT_CHANNELS).optional(),
  urgency_claims: z.array(z.enum(URGENCY_CLAIMS)),
  secrecy_requested: z.boolean(),
  untrusted_contact_details: z
    .object({ claimed_phone: z.string().optional(), claimed_url: z.string().optional(), warning: z.string() })
    .describe('Details taken from the suspicious message. Shown to the trusted contact for context only; never call or open them.'),
  risk_signals: z.array(riskSignal),
  reasons: z.array(reason).describe('Warning signs and blocking reasons as separate items, blocking ones first, each with its official source where there is one. Meant for display as a list.'),
  payee,
  policy: policyDecision.extend({ approval_threshold_usd: z.number() }),
  can_approve: z.boolean(),
  cannot_approve_reason: z.string().optional(),
  requires_trust_payee: z.boolean().describe('True when approving needs trust_payee: true because the payee is not in the official registry.'),
  approval_url: z.string().describe('Signed link to the web approval page for this hold. Only ever given to the trusted contact.'),
});

const circle = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(z.object({ id: z.string(), name: z.string() })),
  contacts: z.array(z.object({ id: z.string(), name: z.string(), relationship: z.string().optional() })),
  policy: z.object({
    approval_threshold_usd: z.number(),
    blocked_methods_official_payees: z.array(z.enum(PAYMENT_METHODS)),
    blocked_methods_all_payees: z.array(z.enum(PAYMENT_METHODS)),
    hold_expiry_hours: z.number(),
    notify_on_stop: z.boolean(),
    always_blocked_methods_official_payees: z
      .array(z.enum(PAYMENT_METHODS))
      .describe('Built-in floor that cannot be changed: these methods are never used to pay an official payee.'),
  }),
  trusted_payees: z.array(z.object({ name: z.string(), added_by: z.string(), added_at: z.string() })),
});

// --- member tools -----------------------------------------------------------

export const CheckRequestInput = z.object({
  description: z
    .string('description is required: say in a sentence or two what is being asked for.')
    .trim()
    .min(3, 'description is too short: say in a sentence or two what is being asked for.')
    .max(2000, 'description must be 2,000 characters or fewer.')
    .describe("What is being asked for, in the user's own words. Include who asked and any threats, deadlines or instructions."),
  payee_name: z.string().trim().min(1).max(200).optional().describe('Who the money would go to, for example "IRS" or "Con Edison".'),
  amount_usd: amountUsd.optional(),
  payment_method: paymentMethod.optional(),
  contact_channel: contactChannel.optional(),
  claimed_phone: z.string().trim().max(60).optional().describe('A phone number the user was told to call or was called from. It is checked against the registry and never repeated back.'),
  claimed_url: z.string().trim().max(500).optional().describe('A link the user was sent. It is checked against the registry and never repeated back.'),
  secrecy_requested: z.boolean().optional().describe('True if the user was told to keep this secret or not to tell family, friends or the bank.'),
  urgency_claims: z
    .array(z.enum(URGENCY_CLAIMS))
    .max(8)
    .optional()
    .describe('Threats or deadlines the requester used, mapped to these fixed values.'),
});

export const CheckRequestOutput = z.object({
  check_id: z.string(),
  verdict: z
    .enum(VERDICTS)
    .describe('stop: do not pay, a known scam pattern or an official-fact conflict was found. hold_for_family: warning signs, ask the trusted contact. verified: confirmed payee and no warning signs. unknown: Hold On cannot confirm the payee either way.'),
  risk_signals: z.array(riskSignal),
  payee,
  policy: policyDecision,
  say_to_user: z.string().describe('A calm sentence or two the assistant can say as is. It contains no phone numbers or links from the suspicious message.'),
  next_step: z
    .enum(NEXT_STEPS)
    .describe('place_hold: call holdon_place_hold with this check_id. pay: call holdon_pay with this check_id. decline: do not pay and do not place a hold.'),
  interpreted: z
    .object({
      payment_method: z.enum(PAYMENT_METHODS),
      payment_method_source: z.enum(['input', 'inferred', 'unknown']),
      contact_channel: z.enum(CONTACT_CHANNELS),
    })
    .describe('How Hold On read the request after normalisation.'),
  clarification: z
    .object({
      field: z.enum(['payment_method', 'contact_channel']),
      status: z.enum(['answered', 'declined', 'ask_user']),
      answer: z.string().optional(),
      question: z.string().optional(),
    })
    .optional()
    .describe('Present when one safety question mattered. ask_user means the client could not show the question: ask it aloud, then call holdon_check_request again with the answer filled in.'),
});

export const VerifyPayeeInput = z.object({
  name: z.string('name is required: who is asking to be paid?').trim().min(1, 'name is required: who is asking to be paid?').max(200).describe('Name of the organisation or person asking to be paid.'),
  phone: z.string().trim().max(60).optional().describe('A phone number to compare with the official numbers on file.'),
  url: z.string().trim().max(500).optional().describe('A link or website to compare with the official domains on file.'),
  address: z.string().trim().max(300).optional().describe('A mailing address to compare with the official payment address on file, where one is on file.'),
});

export const VerifyPayeeOutput = payee.extend({
  say_to_user: z.string(),
});

export const PlaceHoldInput = z.object({
  check_id: checkId
    .optional()
    .describe('The check this hold is for. Strongly preferred: it carries the full context to the trusted contact. With a check_id, the amount, payee and method come from the check; giving different values here is an error.'),
  summary: z
    .string('summary is required: one sentence the trusted contact will read.')
    .trim()
    .min(3, 'summary is too short: write one sentence the trusted contact will read.')
    .max(500)
    .describe('One sentence the trusted contact will read, for example "Mom was asked to pay $2,000 in gift cards to someone claiming to be the IRS."'),
  amount_usd: amountUsd.optional().describe('Only needed without a check_id.'),
  payee_name: z.string().trim().min(1).max(200).optional().describe('Only needed without a check_id.'),
  payment_method: paymentMethod.optional().describe('Only needed without a check_id.'),
});

export const PlaceHoldOutput = z.object({
  hold_id: z.string(),
  status: z.enum(HOLD_STATUSES),
  blocked: z.boolean(),
  notified: z.array(z.object({ name: z.string(), relationship: z.string().optional(), via: z.array(z.string()) })),
  expires_at: z.string(),
  say_to_user: z.string(),
  next_step: z.enum(['wait', 'pay', 'none']),
});

export const GetHoldInput = z.object({ hold_id: holdId });
export const GetHoldOutput = memberHold;

export const ListHoldsInput = z.object({
  status: z
    .enum([...HOLD_STATUSES, 'open', 'all'])
    .optional()
    .describe('Filter by status. "open" means pending_family or approved. Default: all.'),
  limit: z.number().int().min(1).max(50).optional().describe('How many to return, newest first. Default 20.'),
});
export const ListHoldsOutput = z.object({
  holds: z.array(memberHold),
  count: z.number().int(),
  say_to_user: z.string(),
});

export const WaitForDecisionInput = z.object({
  hold_id: holdId,
  timeout_seconds: z
    .number()
    .int()
    .min(1, 'timeout_seconds must be between 1 and 50.')
    .max(50, 'timeout_seconds must be between 1 and 50. Call again to keep waiting.')
    .optional()
    .describe('How long to wait for the trusted contact, 1 to 50 seconds. Default 20. Call again to keep waiting.'),
});
export const WaitForDecisionOutput = memberHold.extend({
  waited_seconds: z.number(),
  timed_out: z.boolean().describe('True when the wait ended with the hold still pending.'),
});

export const PayInput = z.object({
  hold_id: holdId.optional().describe('An approved hold. Use this after the trusted contact has approved.'),
  check_id: checkId.optional().describe('A check whose next_step was "pay" (confirmed payee, under the approval limit).'),
  payment_method: paymentMethod.optional().describe('Only needed when the request did not say how to pay.'),
});
export const PayOutput = receipt.extend({ say_to_user: z.string() });

export const CancelHoldInput = z.object({ hold_id: holdId });
export const CancelHoldOutput = memberHold;

// --- contact tools ----------------------------------------------------------

export const FamilyInboxInput = z.object({
  status: z.enum(['pending', 'all']).optional().describe('pending (default) shows holds waiting for a decision; all includes decided and paid ones.'),
  limit: z.number().int().min(1).max(50).optional().describe('How many to return, newest first. Default 20.'),
});
export const FamilyInboxOutput = z.object({
  holds: z.array(familyHold),
  count: z.number().int(),
  say_to_user: z.string(),
});

export const FamilyDecideInput = z.object({
  hold_id: holdId,
  decision: z.enum(['approve', 'deny'], 'decision must be "approve" or "deny".'),
  note: z.string().trim().max(500).optional().describe('A short message for your family member, read to them with the decision.'),
  trust_payee: z
    .boolean()
    .optional()
    .describe('Set to true to approve a payee that is not in the official registry. It records that you personally know and trust this payee, and remembers it for next time.'),
});
export const FamilyDecideOutput = z.object({
  hold_id: z.string(),
  status: z.enum(HOLD_STATUSES),
  decision,
  payee_status: z.enum(PAYEE_STATUSES),
  trusted_payee_added: z.boolean(),
  say_to_user: z.string(),
});

export const UpdatePolicyInput = z
  .object({
    approval_threshold_usd: z
      .number()
      .min(0, 'approval_threshold_usd must be between 0 and 10,000.')
      .max(10_000, 'approval_threshold_usd must be between 0 and 10,000.')
      .optional()
      .describe('Confirmed payees at or above this amount need your approval. 0 means every payment needs approval.'),
    blocked_methods_official_payees: z
      .array(z.enum(PAYMENT_METHODS))
      .max(10)
      .optional()
      .describe('Extra payment methods never used for government agencies, utilities and other official payees. Gift cards and cryptocurrency are always blocked for them and cannot be removed.'),
    blocked_methods_all_payees: z.array(z.enum(PAYMENT_METHODS)).max(10).optional().describe('Payment methods the family never wants used for anyone.'),
    hold_expiry_hours: z.number().int().min(1).max(168).optional().describe('How long a hold waits for a decision, and how long an approval stays valid. 1 to 168 hours.'),
    notify_on_stop: z.boolean().optional().describe('When a request is stopped, still tell you about it. Default true.'),
    remove_trusted_payee: z.string().trim().min(1).max(200).optional().describe('Name of a payee to remove from the family\'s list of confirmed payees.'),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Give at least one setting to change, for example approval_threshold_usd.',
  });
export const UpdatePolicyOutput = z.object({
  circle,
  changed: z.array(z.string()),
  say_to_user: z.string(),
});

export const GetCircleInput = z.object({});
export const GetCircleOutput = z.object({ circle });
