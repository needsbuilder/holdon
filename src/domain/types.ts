/**
 * Shared vocabulary for Hold On.
 *
 * These constants are the single source of truth for every enum that appears
 * in a tool schema, a registry fact, a rule condition or a database row.
 */

export const PAYMENT_METHODS = [
  'gift_card',
  'crypto',
  'wire',
  'zelle',
  'payment_app',
  'cash',
  'check',
  'card',
  'bank_transfer',
  'unknown',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CONTACT_CHANNELS = ['phone_call', 'text', 'email', 'mail', 'in_person', 'website', 'unknown'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const URGENCY_CLAIMS = [
  'arrest_or_legal_threat',
  'account_or_benefits_suspended',
  'service_shutoff',
  'family_emergency',
  'pay_immediately',
  'limited_time_offer',
  'computer_or_account_compromised',
  'other',
] as const;
export type UrgencyClaim = (typeof URGENCY_CLAIMS)[number];

export const VERDICTS = ['stop', 'hold_for_family', 'verified', 'unknown'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const PAYEE_STATUSES = ['verified', 'family_trusted', 'mismatch', 'not_in_registry'] as const;
export type PayeeStatus = (typeof PAYEE_STATUSES)[number];

export const HOLD_STATUSES = ['pending_family', 'approved', 'denied', 'expired', 'paid', 'cancelled'] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const NEXT_STEPS = ['place_hold', 'pay', 'decline'] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

export const SEVERITIES = ['high', 'medium'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PAYEE_CATEGORIES = ['government', 'utility', 'postal'] as const;
export type PayeeCategory = (typeof PAYEE_CATEGORIES)[number];

export const ROLES = ['member', 'contact'] as const;
export type Role = (typeof ROLES)[number];

/** What the assistant passes to `holdon_check_request`. */
export interface CheckInput {
  description: string;
  payee_name?: string;
  amount_usd?: number;
  payment_method?: PaymentMethod;
  contact_channel?: ContactChannel;
  claimed_phone?: string;
  claimed_url?: string;
  secrecy_requested?: boolean;
  urgency_claims?: UrgencyClaim[];
}

export interface SignalSource {
  publisher: string;
  title: string;
  url: string;
  quote: string;
}

export interface RiskSignal {
  id: string;
  label: string;
  severity: Severity;
  why: string;
  /** Which inputs triggered the rule, in plain words. Never contains text taken from the suspicious message. */
  matched_on: string[];
  source: SignalSource;
}

export type MismatchField = 'url' | 'phone' | 'address' | 'payment_method' | 'contact_channel' | 'payment_request';

export interface PayeeMismatch {
  field: MismatchField;
  code: string;
  severity: Severity;
  detail: string;
  source?: { url: string; quote: string };
}

export interface OfficialPhone {
  label: string;
  number: string;
  source_url: string;
}

/** Registry-verified facts that are safe to read out to the older adult. */
export interface OfficialInfo {
  name: string;
  category: PayeeCategory;
  website: string;
  phones: OfficialPhone[];
  accepted_methods: PaymentMethod[];
  never_methods: PaymentMethod[];
}

export interface PayeeResult {
  status: PayeeStatus;
  /** Official name when the payee is in the registry; otherwise the name as given, with phone numbers and links removed. */
  name?: string;
  registry_id?: string;
  category?: PayeeCategory;
  official?: OfficialInfo;
  /** Supplied details that agree with the registry, e.g. `name`, `url`, `phone`, `payment_method`. */
  matches: string[];
  mismatches: PayeeMismatch[];
  note: string;
}

export interface PolicyDecision {
  requires_family_approval: boolean;
  reason: string;
  /** True when a rule, the registry or the family's policy rules this payment out entirely. */
  blocked: boolean;
  blocked_reasons: string[];
}

export interface Policy {
  /** Verified payees at or above this amount need the trusted contact's approval. */
  approval_threshold_usd: number;
  /** Extra methods never used to pay registry ("official") payees, on top of the built-in floor. */
  blocked_methods_official_payees: PaymentMethod[];
  /** Methods the family never wants used for anyone. */
  blocked_methods_all_payees: PaymentMethod[];
  hold_expiry_hours: number;
  /** When a request is stopped, still tell the trusted contact (as a hold that can only be denied). */
  notify_on_stop: boolean;
}

/** Gift cards and cryptocurrency are never used to pay a registry payee. The family cannot switch this off. */
export const POLICY_FLOOR_BLOCKED_METHODS: readonly PaymentMethod[] = ['gift_card', 'crypto'];

export const DEFAULT_POLICY: Policy = {
  approval_threshold_usd: 100,
  blocked_methods_official_payees: [],
  blocked_methods_all_payees: [],
  hold_expiry_hours: 24,
  notify_on_stop: true,
};

export type ClarifyingField = 'payment_method' | 'contact_channel';

/** Result of the pure rule engine for one request. */
export interface CheckOutcome {
  verdict: Verdict;
  risk_signals: RiskSignal[];
  payee: PayeeResult;
  policy: PolicyDecision;
  next_step: NextStep;
  say_to_user: string;
  /** Payment method after normalisation: the supplied value, or one inferred from the description. */
  effective_method: PaymentMethod;
  method_source: 'input' | 'inferred' | 'unknown';
}

export interface TrustedPayee {
  name: string;
  normalized_name: string;
  added_by: string;
  added_at: string;
  note?: string;
}

export interface Principal {
  user_id: string;
  name: string;
  role: Role;
  circle_id: string;
  relationship?: string;
}
