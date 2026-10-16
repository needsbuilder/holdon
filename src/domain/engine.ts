/**
 * The rule engine.
 *
 * `evaluateRequest` is a pure function: the same request, registry, rules and
 * policy always produce the same verdict. It reads no clock, makes no network
 * call and consults no language model (design principle 1).
 */
import { sayCheck } from './language.js';
import { verifyPayee, type Registry } from './registry.js';
import { inferMethod, lexiconHits, matchPatterns, officialWord, payeeIs, type Features, type RuleSet } from './rules.js';
import { hostMention, methodLabel, normalizeName, normalizeText } from './text.js';
import {
  PAYEE_CATEGORIES,
  POLICY_FLOOR_BLOCKED_METHODS,
  type CheckInput,
  type CheckOutcome,
  type ClarifyingField,
  type HoldReason,
  type NextStep,
  type PayeeResult,
  type PaymentMethod,
  type PaymentRefusalReason,
  type Policy,
  type PolicyDecision,
  type PolicyRule,
  type TrustedPayee,
  type Verdict,
} from './types.js';

export interface EngineContext {
  registry: Registry;
  rules: RuleSet;
  policy: Policy;
  trustedPayees: TrustedPayee[];
  /** Display name of the trusted contact who would be asked. Undefined when the circle has none. */
  contactName?: string;
  /**
   * Payees the family said no to recently: registry ids, and `normalizeName`
   * keys for payees outside the registry. A payment to one of them always goes
   * to the family again, so a denial is not undone by asking a second time.
   */
  recentDenials?: { registryIds: string[]; names: string[] };
}

/** The words the rules look at: the description and the payee name. */
function requestText(input: CheckInput): string {
  return normalizeText(`${input.description} ${input.payee_name ?? ''}`);
}

/** The payee name alone, in the same form. Undefined when no payee was named. */
function payeeText(input: CheckInput): string | undefined {
  const name = normalizeText(input.payee_name ?? '');
  return name.trim() ? name : undefined;
}

function resolveMethod(
  input: CheckInput,
  text: string,
  rules: RuleSet,
  officialPayee: boolean,
): Pick<CheckOutcome, 'effective_method' | 'method_source'> {
  if (input.payment_method && input.payment_method !== 'unknown') {
    return { effective_method: input.payment_method, method_source: 'input' };
  }
  const inferred = inferMethod(text, rules, officialPayee);
  if (inferred) return { effective_method: inferred, method_source: 'inferred' };
  return { effective_method: 'unknown', method_source: 'unknown' };
}

/**
 * Whether the request names, or claims to come from, an official payee: a
 * registry entry, a government agency, utility or post office named as the
 * payee, or general words such as "IRS" or "electric bill" anywhere in the
 * request (see {@link officialWord}). Decides the built-in floor and the
 * family's settings for official payees.
 */
function claimsOfficialPayee(registryId: string | undefined, input: CheckInput, rules: RuleSet): boolean {
  if (registryId) return true;
  const text = requestText(input);
  const payee = payeeText(input);
  return PAYEE_CATEGORIES.some((category) => officialWord(rules, category, text, payee) !== undefined);
}

/** Whether the family said no to a payment to this payee recently. */
function deniedRecently(payee: PayeeResult, input: CheckInput, ctx: EngineContext): boolean {
  const denials = ctx.recentDenials;
  if (!denials) return false;
  if (payee.registry_id) return denials.registryIds.includes(payee.registry_id);
  const key = normalizeName(input.payee_name ?? '');
  return key !== '' && denials.names.includes(key);
}

/** The sentence recorded in `policy.blocked_reasons` for a high-severity pattern. */
function patternBlockReason(label: string): string {
  return `Matches a known scam pattern: ${label}.`;
}

/**
 * The reasons behind an outcome as separate items, each with its source, for
 * showing as a list. Pure, and it adds no wording of its own:
 *
 * - a scam pattern is shown by its `label` from `rules/scam-patterns.json`
 * - an official fact by its `summary` from `registry/payees.json`, or by the
 *   comparison sentence when the mismatch is a number or link that is not on file
 * - a policy block by the sentence already recorded in `policy.blocked_reasons`
 *
 * Reasons that stop the request come first.
 */
export function explainReasons(outcome: Pick<CheckOutcome, 'risk_signals' | 'payee' | 'policy'>): HoldReason[] {
  const patterns: HoldReason[] = outcome.risk_signals.map((signal) => ({
    kind: 'scam_pattern',
    blocking: signal.severity === 'high',
    text: signal.label,
    source: signal.source,
  }));
  const facts: HoldReason[] = outcome.payee.mismatches.map((mismatch) => ({
    kind: 'official_fact',
    blocking: mismatch.severity === 'high',
    text: mismatch.fact ?? mismatch.detail,
    ...(mismatch.source ? { source: { publisher: outcome.payee.name ?? 'Official website', url: mismatch.source.url, quote: mismatch.source.quote } } : {}),
  }));
  // Whatever is left in blocked_reasons was added by policy, not by a pattern or a registry fact.
  const explained = new Set([
    ...outcome.risk_signals.filter((signal) => signal.severity === 'high').map((signal) => patternBlockReason(signal.label)),
    ...outcome.payee.mismatches.filter((mismatch) => mismatch.severity === 'high').map((mismatch) => mismatch.detail),
  ]);
  const policy: HoldReason[] = outcome.policy.blocked_reasons.filter((reason) => !explained.has(reason)).map((text) => ({ kind: 'policy', blocking: true, text }));
  const all = [...patterns, ...facts, ...policy].map((reason) => {
    const mention = reason.source ? hostMention(reason.text, reason.source.url) : undefined;
    return mention && reason.source ? { ...reason, source: { ...reason.source, named_in_text: mention } } : reason;
  });
  return [...all.filter((reason) => reason.blocking), ...all.filter((reason) => !reason.blocking)];
}

/** The policy rules that rule a payment method out, independent of any scam pattern. */
function policyMethodRules(policy: Policy, method: PaymentMethod, officialPayee: boolean): PolicyRule[] {
  const rules: PolicyRule[] = [];
  if (method === 'unknown') return rules;
  if (officialPayee && POLICY_FLOOR_BLOCKED_METHODS.includes(method)) rules.push('floor');
  else if (officialPayee && policy.blocked_methods_official_payees.includes(method)) rules.push('family_official_payees');
  if (policy.blocked_methods_all_payees.includes(method)) rules.push('family_all_payees');
  return rules;
}

/** The sentence recorded in `policy.blocked_reasons` for a policy rule. */
function policyRuleSentence(rule: PolicyRule, method: PaymentMethod): string {
  if (rule === 'floor') return `Hold On never pays a government agency, utility or other official payee with ${methodLabel(method)}.`;
  if (rule === 'family_official_payees') return `The family's settings do not allow paying official payees with ${methodLabel(method)}.`;
  return `The family's settings do not allow payments by ${methodLabel(method)}.`;
}

/** Policy blocks that apply to a payment method, independent of any scam pattern. */
export function policyMethodBlocks(policy: Policy, method: PaymentMethod, officialPayee: boolean): string[] {
  return policyMethodRules(policy, method, officialPayee).map((rule) => policyRuleSentence(rule, method));
}

export function evaluateRequest(input: CheckInput, ctx: EngineContext): CheckOutcome {
  const text = requestText(input);
  const payeeName = payeeText(input);
  // Who the request is to decides whether a gift-occasion word may excuse a gift card mention, so it is found first.
  // Only the payee counts here: "a birthday gift card for my grandson the police officer" is still a present.
  const registryPayee = verifyPayee(ctx.registry, [], { name: input.payee_name, url: input.claimed_url });
  const payeeOfficial = payeeIs(['government', 'utility'], { text, registry_category: registryPayee.category, payee_name: payeeName }, ctx.rules) !== undefined;
  const officialPayee = claimsOfficialPayee(registryPayee.registry_id, input, ctx.rules);
  const { effective_method, method_source } = resolveMethod(input, text, ctx.rules, payeeOfficial);
  const channel = input.contact_channel ?? 'unknown';

  const payee = verifyPayee(ctx.registry, ctx.trustedPayees, {
    name: input.payee_name,
    phone: input.claimed_phone,
    url: input.claimed_url,
    payment_method: effective_method,
    contact_channel: channel,
  });

  const features: Features = {
    text,
    method: effective_method,
    channel,
    claims: input.urgency_claims ?? [],
    secrecy_requested: input.secrecy_requested === true,
    registry_category: payee.category,
    payee_name: payeeName,
  };
  const risk_signals = matchPatterns(features, ctx.rules);

  const blocked_reasons = [
    ...risk_signals.filter((s) => s.severity === 'high').map((s) => patternBlockReason(s.label)),
    ...payee.mismatches.filter((m) => m.severity === 'high').map((m) => m.detail),
    ...policyMethodBlocks(ctx.policy, effective_method, officialPayee),
  ];

  const hasCaution =
    risk_signals.some((s) => s.severity === 'medium') || payee.mismatches.some((m) => m.severity === 'medium');
  const payeeConfirmed = payee.status === 'verified' || payee.status === 'family_trusted';

  let verdict: Verdict;
  if (blocked_reasons.length > 0) verdict = 'stop';
  else if (hasCaution) verdict = 'hold_for_family';
  else if (payeeConfirmed) verdict = 'verified';
  else verdict = 'unknown';

  let policy: PolicyDecision;
  let approvalCause: 'amount_missing' | 'over_limit' | 'recently_denied' | undefined;
  if (verdict === 'stop') {
    policy = {
      requires_family_approval: true,
      reason: 'This request is stopped. It cannot be approved or paid through Hold On.',
      blocked: true,
      blocked_reasons,
    };
  } else if (verdict === 'hold_for_family') {
    policy = {
      requires_family_approval: true,
      reason: 'There are warning signs, so the trusted contact is asked before any money moves.',
      blocked: false,
      blocked_reasons: [],
    };
  } else if (verdict === 'unknown') {
    policy = {
      requires_family_approval: true,
      reason: 'The payee is not in the registry of official payees, so the trusted contact is asked before any money moves.',
      blocked: false,
      blocked_reasons: [],
    };
  } else if (input.amount_usd === undefined) {
    approvalCause = 'amount_missing';
    policy = {
      requires_family_approval: true,
      reason: 'No amount was given, so the trusted contact is asked before any money moves.',
      blocked: false,
      blocked_reasons: [],
    };
  } else if (input.amount_usd >= ctx.policy.approval_threshold_usd) {
    approvalCause = 'over_limit';
    policy = {
      requires_family_approval: true,
      reason: "The amount is at or above the family's approval limit.",
      blocked: false,
      blocked_reasons: [],
    };
  } else if (deniedRecently(payee, input, ctx)) {
    approvalCause = 'recently_denied';
    policy = {
      requires_family_approval: true,
      reason: 'The trusted contact recently said no to a payment to this payee, so they are asked again before any money moves.',
      blocked: false,
      blocked_reasons: [],
    };
  } else {
    policy = {
      requires_family_approval: false,
      reason: "The payee is confirmed and the amount is under the family's approval limit.",
      blocked: false,
      blocked_reasons: [],
    };
  }

  let next_step: NextStep;
  if (verdict === 'stop') next_step = ctx.policy.notify_on_stop && ctx.contactName ? 'place_hold' : 'decline';
  else if (policy.requires_family_approval) next_step = ctx.contactName ? 'place_hold' : 'decline';
  else next_step = 'pay';

  const say_to_user = sayCheck({
    verdict,
    signals: risk_signals,
    payee,
    policy,
    amount_usd: input.amount_usd,
    contactName: ctx.contactName,
    notifyOnStop: ctx.policy.notify_on_stop,
    approvalCause,
  });

  return { verdict, risk_signals, payee, policy, next_step, say_to_user, effective_method, method_source };
}

/**
 * Decide whether one clarifying question would change what Hold On can say.
 *
 * Nothing is asked when the request is already stopped. Otherwise the contact
 * channel comes first for official payees (it decides whether the request
 * could be genuine), then the payment method.
 */
export function pickClarifyingQuestion(input: CheckInput, ctx: EngineContext): ClarifyingField | undefined {
  const outcome = evaluateRequest(input, ctx);
  if (outcome.verdict === 'stop') return undefined;
  const channelMissing = !input.contact_channel || input.contact_channel === 'unknown';
  if (channelMissing && claimsOfficialPayee(outcome.payee.registry_id, input, ctx.rules)) return 'contact_channel';
  if (outcome.method_source === 'unknown') return 'payment_method';
  return undefined;
}

/** Everything that stops this request, in the order it is explained: policy, then scam patterns, then registry facts. */
function refusalReasons(input: CheckInput, ctx: EngineContext): PaymentRefusalReason[] {
  const outcome = evaluateRequest(input, ctx);
  const official = claimsOfficialPayee(outcome.payee.registry_id, input, ctx.rules);
  const officialBy = outcome.payee.registry_id ? 'registry' : 'words';
  return [
    ...policyMethodRules(ctx.policy, outcome.effective_method, official).map(
      (rule): PaymentRefusalReason => ({ kind: 'policy', rule, ...(rule === 'family_all_payees' ? {} : { official_by: officialBy }) }),
    ),
    ...outcome.risk_signals
      .filter((signal) => signal.severity === 'high')
      .map((signal): PaymentRefusalReason => ({ kind: 'scam_pattern', why: signal.why })),
    ...outcome.payee.mismatches
      .filter((mismatch) => mismatch.severity === 'high')
      .map((mismatch): PaymentRefusalReason => ({ kind: 'official_fact', fact: mismatch.fact ?? mismatch.detail })),
  ];
}

export interface PayTimeRefusal {
  /**
   * `method_not_allowed` when the method given at pay time brings the reason.
   * `blocked` when the reason stands whatever the method: the rules, the
   * registry or the family's settings changed after the request was approved.
   */
  code: 'method_not_allowed' | 'blocked';
  /** The one reason to explain: a policy rule first, then a scam pattern, then a registry fact. */
  reason: PaymentRefusalReason;
}

/**
 * Check a payment once more just before it is made, with the method that will
 * actually be used and today's rules, registry and settings.
 *
 * `approvedMethod` is the method the request was approved with (`unknown` when
 * none was given); `method` is the one that will be used. Anything that stops
 * the request with the approved method stands whatever is chosen now. Only
 * what appears with `method` and not with `approvedMethod` is the method's
 * doing. Pure, like {@link evaluateRequest}.
 */
export function payTimeRefusal(input: CheckInput, approvedMethod: PaymentMethod, method: PaymentMethod, ctx: EngineContext): PayTimeRefusal | undefined {
  const standing = refusalReasons({ ...input, payment_method: approvedMethod }, ctx);
  if (standing.length > 0) return { code: 'blocked', reason: standing[0]! };
  if (method === approvedMethod) return undefined;

  const introduced = refusalReasons({ ...input, payment_method: method }, ctx);
  if (approvedMethod === 'unknown') {
    // The request's words mention gift cards or cryptocurrency, but the method is first named now, as something else.
    // Refusing is safer than asking the family: whoever approved it (the family, or the family's settings) did so
    // without a method, and a hold placed now would still show the family the same words without one. A new check
    // with the method stated lets the rules and the family see both together. (A gift card mention gets this far only
    // beside a gift-occasion word, as in "a gift card for her birthday"; cryptocurrency words stop the check itself.)
    const text = requestText(input);
    for (const mentioned of ['gift_card', 'crypto'] as const) {
      if (method !== mentioned && lexiconHits(ctx.rules, mentioned, text).length > 0) introduced.push({ kind: 'mentioned_method', mentioned });
    }
  }
  return introduced.length > 0 ? { code: 'method_not_allowed', reason: introduced[0]! } : undefined;
}
