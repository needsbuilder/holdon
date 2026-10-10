/**
 * Scam patterns as data, and the tiny interpreter that evaluates them.
 *
 * A pattern matches when its `when` condition is true for the request's
 * features. Conditions are plain JSON (all / any / not over a handful of
 * atoms), so a rule can be reviewed, sourced and tested without reading code.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { packagePath } from '../paths.js';
import { containsPhrase } from './text.js';
import {
  CONTACT_CHANNELS,
  PAYEE_CATEGORIES,
  PAYMENT_METHODS,
  SEVERITIES,
  URGENCY_CLAIMS,
  type ContactChannel,
  type PayeeCategory,
  type PaymentMethod,
  type RiskSignal,
  type UrgencyClaim,
} from './types.js';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { method_in: PaymentMethod[] }
  | { channel_in: ContactChannel[] }
  | { claim_in: UrgencyClaim[] }
  | { flag: 'secrecy_requested' }
  | { payee_category_in: PayeeCategory[] }
  | { text: string };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ConditionSchema).min(1) }),
    z.strictObject({ any: z.array(ConditionSchema).min(1) }),
    z.strictObject({ not: ConditionSchema }),
    z.strictObject({ method_in: z.array(z.enum(PAYMENT_METHODS)).min(1) }),
    z.strictObject({ channel_in: z.array(z.enum(CONTACT_CHANNELS)).min(1) }),
    z.strictObject({ claim_in: z.array(z.enum(URGENCY_CLAIMS)).min(1) }),
    z.strictObject({ flag: z.literal('secrecy_requested') }),
    z.strictObject({ payee_category_in: z.array(z.enum(PAYEE_CATEGORIES)).min(1) }),
    z.strictObject({ text: z.string().min(1) }),
  ]),
);

export const GuidanceSchema = z.strictObject({
  publisher: z.string().min(2),
  title: z.string().min(3),
  source_url: z.url({ protocol: /^https$/ }),
  quote: z.string().min(3),
  quote_context: z.string().min(3).optional(),
  checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const PatternSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(5),
  severity: z.enum(SEVERITIES),
  why: z.string().min(10),
  when: ConditionSchema,
  guidance: z.array(GuidanceSchema).min(1),
});
export type Pattern = z.infer<typeof PatternSchema>;

export const RuleFileSchema = z.strictObject({
  version: z.string(),
  about: z.string(),
  condition_language: z.record(z.string(), z.string()),
  lexicons: z.record(z.string(), z.array(z.string().min(2)).min(1)),
  patterns: z.array(PatternSchema).min(1),
});
export type RuleSet = z.infer<typeof RuleFileSchema>;

let cached: RuleSet | undefined;

export function loadRules(path = packagePath('rules', 'scam-patterns.json')): RuleSet {
  const isDefault = path === packagePath('rules', 'scam-patterns.json');
  if (isDefault && cached) return cached;
  const rules = RuleFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  for (const name of referencedLexicons(rules)) {
    if (!rules.lexicons[name]) throw new Error(`Rule file refers to unknown lexicon "${name}".`);
  }
  if (isDefault) cached = rules;
  return rules;
}

function walk(condition: Condition, visit: (c: Condition) => void): void {
  visit(condition);
  if ('all' in condition) condition.all.forEach((c) => walk(c, visit));
  else if ('any' in condition) condition.any.forEach((c) => walk(c, visit));
  else if ('not' in condition) walk(condition.not, visit);
}

export function referencedLexicons(rules: RuleSet): Set<string> {
  const names = new Set<string>();
  for (const pattern of rules.patterns) {
    walk(pattern.when, (c) => {
      if ('text' in c) names.add(c.text);
    });
  }
  return names;
}

/** Everything a condition can look at. Built once per request by the engine. */
export interface Features {
  /** Output of `normalizeText` over the description, summary and payee name. */
  text: string;
  method: PaymentMethod;
  channel: ContactChannel;
  claims: UrgencyClaim[];
  secrecy_requested: boolean;
  /** Category of the registry payee, if one was named. */
  registry_category?: PayeeCategory;
}

/** Lexicons that stand in for a payee category when the payee is not in the registry. */
const CATEGORY_LEXICON: Partial<Record<PayeeCategory, string>> = {
  government: 'government',
  utility: 'utility',
};

function lexiconHits(rules: RuleSet, name: string, text: string): string[] {
  return (rules.lexicons[name] ?? []).filter((phrase) => containsPhrase(text, phrase));
}

/**
 * Evaluate a condition. Returns the evidence for a match (possibly empty for
 * a bare `not`), or undefined when the condition does not match.
 */
export function evaluateCondition(condition: Condition, features: Features, rules: RuleSet): string[] | undefined {
  if ('all' in condition) {
    const evidence: string[] = [];
    for (const child of condition.all) {
      const result = evaluateCondition(child, features, rules);
      if (!result) return undefined;
      evidence.push(...result);
    }
    return evidence;
  }
  if ('any' in condition) {
    const evidence: string[] = [];
    let matched = false;
    for (const child of condition.any) {
      const result = evaluateCondition(child, features, rules);
      if (result) {
        matched = true;
        evidence.push(...result);
      }
    }
    return matched ? evidence : undefined;
  }
  if ('not' in condition) {
    return evaluateCondition(condition.not, features, rules) ? undefined : [];
  }
  if ('method_in' in condition) {
    return condition.method_in.includes(features.method) ? [`payment method: ${features.method}`] : undefined;
  }
  if ('channel_in' in condition) {
    return condition.channel_in.includes(features.channel) ? [`contact channel: ${features.channel}`] : undefined;
  }
  if ('claim_in' in condition) {
    const hits = features.claims.filter((claim) => condition.claim_in.includes(claim));
    return hits.length > 0 ? hits.map((claim) => `urgency claim: ${claim}`) : undefined;
  }
  if ('flag' in condition) {
    return features[condition.flag] ? ['secrecy was requested'] : undefined;
  }
  if ('payee_category_in' in condition) {
    if (features.registry_category && condition.payee_category_in.includes(features.registry_category)) {
      return [`payee category: ${features.registry_category}`];
    }
    for (const category of condition.payee_category_in) {
      const lexicon = CATEGORY_LEXICON[category];
      const hits = lexicon ? lexiconHits(rules, lexicon, features.text) : [];
      if (hits.length > 0) return [`mentions ${category}: "${hits[0]}"`];
    }
    return undefined;
  }
  const hits = lexiconHits(rules, condition.text, features.text);
  return hits.length > 0 ? hits.slice(0, 3).map((phrase) => `words: "${phrase}"`) : undefined;
}

/** All patterns that match, in file order, each with its primary official source. */
export function matchPatterns(features: Features, rules: RuleSet): RiskSignal[] {
  const signals: RiskSignal[] = [];
  for (const pattern of rules.patterns) {
    const evidence = evaluateCondition(pattern.when, features, rules);
    if (!evidence) continue;
    const primary = pattern.guidance[0]!;
    signals.push({
      id: pattern.id,
      label: pattern.label,
      severity: pattern.severity,
      why: pattern.why,
      matched_on: [...new Set(evidence)],
      source: { publisher: primary.publisher, title: primary.title, url: primary.source_url, quote: primary.quote },
    });
  }
  return signals;
}

/** Words that reveal the payment method when the assistant did not pass one. */
const METHOD_HINTS: Array<{ method: PaymentMethod; lexicon?: string; phrases?: string[]; unless?: string }> = [
  // Buying a gift card as a present is not the same as paying someone with one.
  { method: 'gift_card', lexicon: 'gift_card', unless: 'gift_occasion' },
  { method: 'crypto', lexicon: 'crypto' },
  { method: 'wire', phrases: ['wire', 'wire transfer', 'wire the money', 'western union', 'moneygram', 'money gram'] },
  { method: 'zelle', phrases: ['zelle'] },
  { method: 'payment_app', phrases: ['venmo', 'cash app', 'cashapp', 'paypal', 'apple cash', 'payment app'] },
  { method: 'cash', phrases: ['cash', 'in cash', 'mail cash'] },
];

export function inferMethod(text: string, rules: RuleSet): PaymentMethod | undefined {
  for (const hint of METHOD_HINTS) {
    const phrases = hint.lexicon ? (rules.lexicons[hint.lexicon] ?? []) : (hint.phrases ?? []);
    if (!phrases.some((phrase) => containsPhrase(text, phrase))) continue;
    if (hint.unless && (rules.lexicons[hint.unless] ?? []).some((phrase) => containsPhrase(text, phrase))) continue;
    return hint.method;
  }
  return undefined;
}
