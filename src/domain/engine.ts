/**
 * The rule engine.
 *
 * `evaluateRequest` is a pure function: the same request, registry, rules and
 * policy always produce the same verdict. It reads no clock, makes no network
 * call and consults no language model (design principle 1).
 */
import { sayCheck } from './language.js';
import { verifyPayee, type Registry } from './registry.js';
import { inferMethod, matchPatterns, type Features, type RuleSet } from './rules.js';
import { containsPhrase, hostMention, methodLabel, normalizeText } from './text.js';
import {
  POLICY_FLOOR_BLOCKED_METHODS,
  type CheckInput,
  type CheckOutcome,
  type ClarifyingField,
  type HoldReason,
  type NextStep,
  type PaymentMethod,
  type Policy,
  type PolicyDecision,
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
}

function resolveMethod(input: CheckInput, text: string, rules: RuleSet): Pick<CheckOutcome, 'effective_method' | 'method_source'> {
  if (input.payment_method && input.payment_method !== 'unknown') {
    return { effective_method: input.payment_method, method_source: 'input' };
  }
  const inferred = inferMethod(text, rules);
  if (inferred) return { effective_method: inferred, method_source: 'inferred' };
  return { effective_method: 'unknown', method_source: 'unknown' };
}

/** Whether the request names, or claims to come from, an official payee (registry entry, government or utility). */
function claimsOfficialPayee(registryId: string | undefined, text: string, rules: RuleSet): boolean {
  if (registryId) return true;
  return ['government', 'utility'].some((lexicon) =>
    (rules.lexicons[lexicon] ?? []).some((phrase) => containsPhrase(text, phrase)),
  );
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

/** Policy blocks that apply to a payment method, independent of any scam pattern. */
export function policyMethodBlocks(policy: Policy, method: PaymentMethod, officialPayee: boolean): string[] {
  const reasons: string[] = [];
  if (method === 'unknown') return reasons;
  if (officialPayee && POLICY_FLOOR_BLOCKED_METHODS.includes(method)) {
    reasons.push(`Hold On never pays a government agency, utility or other official payee with ${methodLabel(method)}.`);
  } else if (officialPayee && policy.blocked_methods_official_payees.includes(method)) {
    reasons.push(`The family's settings do not allow paying official payees with ${methodLabel(method)}.`);
  }
  if (policy.blocked_methods_all_payees.includes(method)) {
    reasons.push(`The family's settings do not allow payments by ${methodLabel(method)}.`);
  }
  return reasons;
}

export function evaluateRequest(input: CheckInput, ctx: EngineContext): CheckOutcome {
  const text = normalizeText(`${input.description} ${input.payee_name ?? ''}`);
  const { effective_method, method_source } = resolveMethod(input, text, ctx.rules);
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
  };
  const risk_signals = matchPatterns(features, ctx.rules);

  const officialPayee = claimsOfficialPayee(payee.registry_id, text, ctx.rules);
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
  let approvalCause: 'amount_missing' | 'over_limit' | undefined;
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
  const text = normalizeText(`${input.description} ${input.payee_name ?? ''}`);
  const channelMissing = !input.contact_channel || input.contact_channel === 'unknown';
  if (channelMissing && claimsOfficialPayee(outcome.payee.registry_id, text, ctx.rules)) return 'contact_channel';
  if (outcome.method_source === 'unknown') return 'payment_method';
  return undefined;
}
