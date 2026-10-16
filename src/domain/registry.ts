/**
 * The payee registry: a small set of official US payees with contact and
 * payment facts read from each organisation's own website.
 *
 * Design principle 1: a payee is "verified" only when it is in this registry
 * (or the family has explicitly vouched for it). Anything else is reported as
 * `not_in_registry`. The code never guesses.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { packagePath } from '../paths.js';
import {
  channelLabel,
  extractHost,
  hostMatchesDomain,
  methodLabel,
  normalizeName,
  normalizeText,
  phoneDigits,
  redactUntrusted,
} from './text.js';
import {
  CONTACT_CHANNELS,
  PAYEE_CATEGORIES,
  PAYMENT_METHODS,
  type ContactChannel,
  type OfficialInfo,
  type PayeeMismatch,
  type PayeeResult,
  type PaymentMethod,
  type TrustedPayee,
} from './types.js';

const sourced = {
  source_url: z.url({ protocol: /^https$/ }),
  quote: z.string().min(3),
  quote_context: z.string().min(3).optional(),
  checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

const methodList = z.array(z.enum(PAYMENT_METHODS)).min(1);

export const PayeeEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(2),
  aliases: z.array(z.string().min(2)),
  category: z.enum(PAYEE_CATEGORIES),
  official_domains: z.array(z.strictObject({ domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/), ...sourced })).min(1),
  phones: z.array(z.strictObject({ label: z.string().min(2), number: z.string().min(7), ...sourced })),
  addresses: z.array(z.strictObject({ label: z.string().min(2), address: z.string().min(8), ...sourced })),
  accepted_methods: z.array(z.strictObject({ methods: methodList, summary: z.string().min(5), ...sourced })),
  never_methods: z.array(z.strictObject({ methods: methodList, summary: z.string().min(5), ...sourced })),
  contact_facts: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9-]+$/),
      summary: z.string().min(5),
      /** Channels the organisation says it does not use to ask for money or sensitive details. */
      unsolicited_channels: z.array(z.enum(CONTACT_CHANNELS)).optional(),
      never_asks_for_money: z.boolean().optional(),
      ...sourced,
    }),
  ),
});
export type PayeeEntry = z.infer<typeof PayeeEntrySchema>;

export const RegistrySchema = z.strictObject({
  version: z.string(),
  about: z.string(),
  method_vocabulary_note: z.string(),
  payees: z.array(PayeeEntrySchema).min(1),
});
export type RegistryFile = z.infer<typeof RegistrySchema>;

export interface Registry {
  version: string;
  payees: PayeeEntry[];
  byId: Map<string, PayeeEntry>;
}

export function buildRegistry(file: RegistryFile): Registry {
  return { version: file.version, payees: file.payees, byId: new Map(file.payees.map((p) => [p.id, p])) };
}

let cached: Registry | undefined;

export function loadRegistry(path = packagePath('registry', 'payees.json')): Registry {
  if (path === packagePath('registry', 'payees.json') && cached) return cached;
  const registry = buildRegistry(RegistrySchema.parse(JSON.parse(readFileSync(path, 'utf8'))));
  if (path === packagePath('registry', 'payees.json')) cached = registry;
  return registry;
}

export interface PayeeQuery {
  name?: string;
  phone?: string;
  url?: string;
  address?: string;
  payment_method?: PaymentMethod;
  contact_channel?: ContactChannel;
}

function officialInfo(entry: PayeeEntry): OfficialInfo {
  const unique = (lists: PaymentMethod[][]) => [...new Set(lists.flat())];
  return {
    name: entry.name,
    category: entry.category,
    website: entry.official_domains[0]!.domain,
    phones: entry.phones.map((p) => ({ label: p.label, number: p.number, source_url: p.source_url })),
    accepted_methods: unique(entry.accepted_methods.map((m) => m.methods)),
    never_methods: unique(entry.never_methods.map((m) => m.methods)),
  };
}

/** Find the registry entry a name refers to: the longest name or alias that appears as whole words. */
export function findPayeeByName(registry: Registry, name: string): PayeeEntry | undefined {
  const haystack = normalizeText(name);
  let best: { entry: PayeeEntry; length: number } | undefined;
  for (const entry of registry.payees) {
    for (const candidate of [entry.name, ...entry.aliases]) {
      const needle = normalizeText(candidate);
      if (haystack.includes(needle) && (!best || needle.length > best.length)) {
        best = { entry, length: needle.length };
      }
    }
  }
  return best?.entry;
}

/**
 * The payee the family vouched for under this exact name, if any.
 *
 * A name with nothing to match on never matches. The entry's own name must
 * also normalise to the same key, so a row stored under an older, looser key
 * cannot stand in for a different name.
 */
export function findTrustedPayee(trustedPayees: TrustedPayee[], name: string | undefined): TrustedPayee | undefined {
  const key = name ? normalizeName(name) : '';
  if (!key) return undefined;
  return trustedPayees.find((t) => t.normalized_name === key && normalizeName(t.name) === key);
}

function findPayeeByHost(registry: Registry, host: string): PayeeEntry | undefined {
  return registry.payees.find((entry) => entry.official_domains.some((d) => hostMatchesDomain(host, d.domain)));
}

/**
 * A host that is not official but contains an official site's name as a whole
 * token, e.g. "usps-redelivery.example" or "irs.gov.pay-now.example".
 */
function findLookalike(registry: Registry, host: string): PayeeEntry | undefined {
  const tokens = new Set(host.split(/[^a-z0-9]+/).filter(Boolean));
  const collapsed = host.replace(/[^a-z0-9]/g, '');
  for (const entry of registry.payees) {
    for (const { domain } of entry.official_domains) {
      const label = domain.split('.')[0]!;
      const plain = label.replace(/-/g, '');
      if (tokens.has(label) || tokens.has(plain)) return entry;
      // Longer brand names are distinctive enough to match inside a run-together host name.
      if (plain.length >= 6 && collapsed.includes(plain)) return entry;
    }
  }
  return undefined;
}

function addressMatches(given: string, official: string): boolean {
  const digits = (value: string) => value.match(/\d{3,}/g) ?? [];
  const officialNumbers = digits(official);
  const givenNumbers = new Set(digits(given));
  // Every number in the official address (box number, ZIP) must appear in what the user was given.
  return officialNumbers.length > 0 && officialNumbers.every((n) => givenNumbers.has(n));
}

/**
 * Compare what the user was told about a payee with the registry.
 *
 * Pure: same inputs, same answer. The returned text never repeats the phone
 * number, link or address that was supplied; only registry facts are quoted.
 */
export function verifyPayee(registry: Registry, trustedPayees: TrustedPayee[], query: PayeeQuery): PayeeResult {
  const matches: string[] = [];
  const mismatches: PayeeMismatch[] = [];
  const host = query.url ? extractHost(query.url) : undefined;

  let entry = query.name ? findPayeeByName(registry, query.name) : undefined;
  if (entry) matches.push('name');

  let lookalikeOf: PayeeEntry | undefined;
  if (!entry && host) {
    const byHost = findPayeeByHost(registry, host);
    if (byHost) {
      entry = byHost;
    } else {
      lookalikeOf = findLookalike(registry, host);
      entry = lookalikeOf;
    }
  }

  if (!entry) {
    const displayName = query.name ? redactUntrusted(query.name).trim() : undefined;
    const trusted = findTrustedPayee(trustedPayees, query.name);
    if (trusted) {
      // The name the family vouched for can hold a number or link the caller gave. It is said and shown without them.
      const name = redactUntrusted(trusted.name).trim();
      return {
        status: 'family_trusted',
        name,
        matches: ['name'],
        mismatches: [],
        note: `${name} is not in the official registry, but ${trusted.added_by} has confirmed this payee for the family.`,
      };
    }
    return {
      status: 'not_in_registry',
      ...(displayName ? { name: displayName } : {}),
      matches: [],
      mismatches: [],
      note: displayName
        ? `"${displayName}" is not in the registry of official payees, so its details cannot be confirmed here. That is not a sign that anything is wrong; the registry is small.`
        : 'No payee was named, so there is nothing to compare with the registry.',
    };
  }

  const official = officialInfo(entry);
  const domainList = entry.official_domains.map((d) => d.domain).join(' or ');

  if (query.url) {
    if (!host) {
      mismatches.push({
        field: 'url',
        code: 'url_unreadable',
        severity: 'medium',
        detail: `The link that was given could not be read as a web address. ${entry.name}'s official site is ${domainList}.`,
      });
    } else if (entry.official_domains.some((d) => hostMatchesDomain(host, d.domain))) {
      matches.push('url');
    } else {
      const domainFact = entry.official_domains[0]!;
      mismatches.push({
        field: 'url',
        code: lookalikeOf ? 'lookalike_domain' : 'url_not_official',
        severity: 'high',
        detail: lookalikeOf
          ? `The link that was given uses ${entry.name}'s name but is not on its official site, ${domainList}.`
          : `The link that was given is not on ${entry.name}'s official site, ${domainList}.`,
        source: { url: domainFact.source_url, quote: domainFact.quote },
      });
    }
  }

  if (query.phone) {
    const given = phoneDigits(query.phone);
    if (entry.phones.length === 0) {
      // Honest unknown: nothing on file to compare with.
    } else if (given && entry.phones.some((p) => phoneDigits(p.number) === given)) {
      matches.push('phone');
    } else {
      const first = entry.phones[0]!;
      mismatches.push({
        field: 'phone',
        code: 'phone_not_on_file',
        severity: 'medium',
        detail: `The phone number that was given is not one of the numbers ${entry.name} publishes on ${extractHost(first.source_url) ?? 'its official website'}. Caller ID can also be faked, so it is safer to call the official number.`,
        source: { url: first.source_url, quote: first.quote },
      });
    }
  }

  if (query.address && entry.addresses.length > 0) {
    if (entry.addresses.some((a) => addressMatches(query.address!, a.address))) {
      matches.push('address');
    } else {
      const first = entry.addresses[0]!;
      mismatches.push({
        field: 'address',
        code: 'address_not_on_file',
        severity: 'medium',
        detail: `The mailing address that was given does not match the address ${entry.name} publishes for payments.`,
        source: { url: first.source_url, quote: first.quote },
      });
    }
  }

  const method = query.payment_method;
  if (method && method !== 'unknown') {
    const never = entry.never_methods.find((fact) => fact.methods.includes(method));
    if (never) {
      mismatches.push({
        field: 'payment_method',
        code: 'method_never_used',
        severity: 'high',
        detail: `${entry.name} says it does not take payment by ${methodLabel(method)}. ${never.summary}`,
        fact: never.summary,
        source: { url: never.source_url, quote: never.quote },
      });
    } else if (entry.accepted_methods.some((fact) => fact.methods.includes(method))) {
      matches.push('payment_method');
    }
  }

  const neverAsks = entry.contact_facts.find((fact) => fact.never_asks_for_money);
  if (neverAsks) {
    mismatches.push({
      field: 'payment_request',
      code: 'never_asks_for_money',
      severity: 'high',
      detail: `${neverAsks.summary} A request to pay ${entry.name} does not come from the real agency.`,
      fact: neverAsks.summary,
      source: { url: neverAsks.source_url, quote: neverAsks.quote },
    });
  }

  const channel = query.contact_channel;
  if (channel && channel !== 'unknown') {
    const fact = entry.contact_facts.find((f) => f.unsolicited_channels?.includes(channel));
    if (fact) {
      mismatches.push({
        field: 'contact_channel',
        code: 'channel_not_used',
        severity: 'medium',
        detail: `This request came by ${channelLabel(channel)}. ${fact.summary}`,
        fact: fact.summary,
        source: { url: fact.source_url, quote: fact.quote },
      });
    }
  }

  const status = mismatches.length > 0 ? 'mismatch' : 'verified';
  const checkedDetails = matches.filter((m) => m !== 'name');
  let note: string;
  if (status === 'mismatch') {
    note = `${entry.name} is in the registry, but ${mismatches.length === 1 ? 'one detail does' : 'some details do'} not agree with its official information.`;
  } else if (checkedDetails.length > 0) {
    note = `${entry.name} is in the registry and the ${checkedDetails.join(', ').replace('payment_method', 'payment method')} supplied ${checkedDetails.length === 1 ? 'agrees' : 'agree'} with its official information.`;
  } else {
    note = `${entry.name} is in the registry. It was matched by name only, so this confirms who the real payee is, not who made the request.`;
  }

  return {
    status,
    name: entry.name,
    registry_id: entry.id,
    category: entry.category,
    official,
    matches,
    mismatches,
    note,
  };
}
