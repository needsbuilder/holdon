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
import { containsPhrase, normalizeText, readings } from './text.js';
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
  | { payee_is: PayeeCategory[] }
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
    z.strictObject({ payee_is: z.array(z.enum(PAYEE_CATEGORIES)).min(1) }),
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
  /** Output of `normalizeText` over the payee name alone. Undefined when no payee was named. */
  payee_name?: string;
}

/** Lexicons that stand in for a payee category when the payee is not in the registry. */
const CATEGORY_LEXICON: Partial<Record<PayeeCategory, string>> = {
  government: 'government',
  utility: 'utility',
};

/**
 * Amount forms a list of phrases cannot spell out, read in the same normalised text as the phrases, where "$500"
 * reads "500" and "0.5 ETH" reads "0 5 eth": "$500 of Google Play" or "500 dollars of google play" for gift cards,
 * "0.5 ETH" or "2 ether" for cryptocurrency.
 */
const AMOUNT_FORMS: Record<string, RegExp> = {
  gift_card: / \d+ (?:dollars? )?of google play(?= )/,
  crypto: / \d+ ?eth(?:er)?(?= )/,
};

/** The phrases of a lexicon that `text` (an output of `normalizeText`) contains, and the lexicon's amount form if it does. */
export function lexiconHits(rules: RuleSet, name: string, text: string): string[] {
  const hits = (rules.lexicons[name] ?? []).filter((phrase) => containsPhrase(text, phrase));
  const amount = AMOUNT_FORMS[name]?.exec(text);
  return amount ? [...hits, amount[0].trim()] : hits;
}

/** Words that may follow an agency's or utility's own name and still name it: "Georgia Power Company", "Georgia Power billing". */
const TRAILING_WORDS = /(?: (?:company|co|corp|corporation|inc|bill|billing|payment|payments|customer service|account))+$/;
/** The same, and words that may follow a name ending such as "DMV": "Virginia DMV Office", "DMV renewal". */
const TRAILING_WORDS_AFTER_ENDING = /(?: (?:company|co|corp|corporation|inc|bill|billing|payment|payments|customer service|account|office|renewal|registration|fee|fees))+$/;

/**
 * The phrase that says a payee belongs to `category` without the registry, if any.
 *
 * The scam patterns read only the category's own lexicon, which counts
 * anywhere in `text` ("a man from the IRS called"). Deciding whether a payee is
 * official also reads three more lists, so that their specific agency, court,
 * utility and postal names never start a scam stop on their own. They are read
 * in the payee name, so a word elsewhere in the request does not make a private
 * payee official ("pay the roofer my son at the State Police recommended"):
 *
 * - `<category>_payee`: phrases that count anywhere in the payee name, or in
 *   `text` when no payee was named;
 * - `<category>_name_start`: phrases that count only at the start of the payee
 *   name ("City of Springfield", not "the city of light");
 * - `<category>_name`: names that count only as the whole payee name, because
 *   private businesses start with them too ("Georgia Power", not "Georgia Power Washing");
 * - `<category>_name_end`: names that count only at the end of the payee name
 *   ("Virginia DMV", not "DMV Roofing").
 *
 * A leading "the" is not part of the name, and words such as "Company" or
 * "billing" may follow a whole name; "Office", "renewal", "registration" or
 * "fee" may also follow a name ending. `text` and `payeeName` are outputs of
 * `normalizeText`; each reading of the payee name is tried.
 */
export function officialWord(rules: RuleSet, category: PayeeCategory, text: string, payeeName?: string): string | undefined {
  const own = CATEGORY_LEXICON[category];
  const hit = (own ? lexiconHits(rules, own, text)[0] : undefined) ?? lexiconHits(rules, `${category}_payee`, payeeName ?? text)[0];
  if (hit) return hit;
  if (!payeeName) return undefined;
  for (const reading of readings(payeeName)) {
    const name = reading.replace(/^ the /, ' ');
    const start = (rules.lexicons[`${category}_name_start`] ?? []).find((phrase) => name.startsWith(normalizeText(phrase).trimEnd() + ' '));
    if (start) return start;
    const whole = name.trim().replace(TRAILING_WORDS, '');
    const entry = (rules.lexicons[`${category}_name`] ?? []).find((candidate) => normalizeText(candidate).trim() === whole);
    if (entry) return entry;
    const beforeTrailing = ` ${name.trim().replace(TRAILING_WORDS_AFTER_ENDING, '')}`;
    const ending = (rules.lexicons[`${category}_name_end`] ?? []).find((phrase) => beforeTrailing.endsWith(normalizeText(phrase).trimEnd()));
    if (ending) return ending;
  }
  return undefined;
}

/**
 * Evidence that the payee itself is in one of `categories`, or undefined.
 * Its registry entry decides first; otherwise the words of the payee name,
 * or of the whole request when no payee was named.
 */
export function payeeIs(categories: readonly PayeeCategory[], features: Pick<Features, 'text' | 'registry_category' | 'payee_name'>, rules: RuleSet): string | undefined {
  if (features.registry_category && categories.includes(features.registry_category)) return `payee category: ${features.registry_category}`;
  for (const category of categories) {
    const hit = officialWord(rules, category, features.payee_name ?? features.text, features.payee_name);
    if (hit) return `payee named as ${category}: "${hit}"`;
  }
  return undefined;
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
  if ('payee_is' in condition) {
    const evidence = payeeIs(condition.payee_is, features, rules);
    return evidence ? [evidence] : undefined;
  }
  const hits = lexiconHits(rules, condition.text, features.text);
  // Report "google play cards", not also the "google play" inside it.
  const longest = hits.filter((phrase) => !hits.some((other) => other !== phrase && containsPhrase(normalizeText(other), phrase)));
  return longest.length > 0 ? longest.slice(0, 3).map((phrase) => `words: "${phrase}"`) : undefined;
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
  // Buying a gift card as a present is not the same as paying someone with one. Nobody buys a government
  // agency or utility a present, so when the payee is one the exception never applies. (The post office is
  // left out: it sells gift cards, and presents are mailed there.)
  { method: 'gift_card', lexicon: 'gift_card', unless: 'gift_occasion' },
  { method: 'crypto', lexicon: 'crypto' },
  { method: 'wire', phrases: ['wire', 'wire transfer', 'wire the money', 'western union', 'moneygram', 'money gram'] },
  { method: 'zelle', phrases: ['zelle'] },
  { method: 'payment_app', phrases: ['venmo', 'cash app', 'cashapp', 'paypal', 'apple cash', 'payment app'] },
  { method: 'cash', phrases: ['cash', 'in cash', 'mail cash'] },
];

/** `officialPayee`: the payee itself is a government agency or utility, as the `payee_is` condition decides. */
export function inferMethod(text: string, rules: RuleSet, officialPayee = false): PaymentMethod | undefined {
  for (const hint of METHOD_HINTS) {
    const named = hint.lexicon ? lexiconHits(rules, hint.lexicon, text).length > 0 : (hint.phrases ?? []).some((phrase) => containsPhrase(text, phrase));
    if (!named) continue;
    if (hint.unless && !officialPayee && lexiconHits(rules, hint.unless, text).length > 0) continue;
    return hint.method;
  }
  return undefined;
}
