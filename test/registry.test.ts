import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RegistrySchema, findPayeeByName, loadRegistry, verifyPayee, type PayeeEntry } from '../src/domain/registry.js';
import { containsActionableContact, extractHost, hostMatchesDomain, phoneDigits } from '../src/domain/text.js';
import { packagePath } from '../src/paths.js';

const registry = loadRegistry();
const FACT_GROUPS = ['official_domains', 'phones', 'addresses', 'accepted_methods', 'never_methods', 'contact_facts'] as const;

function factsOf(payee: PayeeEntry) {
  return FACT_GROUPS.flatMap((group) => payee[group].map((fact) => ({ group, fact: fact as Record<string, unknown> })));
}

const wordCount = (text: string) => text.trim().split(/\s+/).length;

describe('registry/payees.json', () => {
  it('parses against the strict schema', () => {
    const raw = JSON.parse(readFileSync(packagePath('registry', 'payees.json'), 'utf8'));
    expect(() => RegistrySchema.parse(raw)).not.toThrow();
  });

  it('holds between 8 and 12 payees with unique ids', () => {
    expect(registry.payees.length).toBeGreaterThanOrEqual(8);
    expect(registry.payees.length).toBeLessThanOrEqual(12);
    expect(new Set(registry.payees.map((p) => p.id)).size).toBe(registry.payees.length);
  });

  it('covers the payees an older adult is most often asked to pay', () => {
    for (const id of ['irs', 'ssa', 'medicare', 'usps']) expect(registry.byId.has(id)).toBe(true);
    expect(registry.payees.filter((p) => p.category === 'utility').length).toBeGreaterThanOrEqual(3);
  });

  describe.each(registry.payees.map((payee) => [payee.id, payee] as const))('%s', (_id, payee) => {
    const facts = factsOf(payee);

    it('has at least one official domain and at least three sourced facts', () => {
      expect(payee.official_domains.length).toBeGreaterThanOrEqual(1);
      expect(facts.length).toBeGreaterThanOrEqual(3);
    });

    it('gives every fact a source_url, a verbatim quote and a checked date', () => {
      for (const { group, fact } of facts) {
        const where = `${payee.id}.${group}`;
        expect(fact.source_url, where).toMatch(/^https:\/\//);
        expect(typeof fact.quote, where).toBe('string');
        expect((fact.quote as string).trim().length, where).toBeGreaterThan(0);
        expect(fact.checked, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(fact.checked as string)), where).toBe(false);
      }
    });

    it('keeps every quote under 25 words', () => {
      for (const { group, fact } of facts) {
        expect(wordCount(fact.quote as string), `${payee.id}.${group}: "${fact.quote as string}"`).toBeLessThan(25);
      }
    });

    it("cites only the organisation's own websites", () => {
      // The FTC registry entry is sourced from the FTC's consumer site; every other payee from its own domains.
      const ownDomains = new Set(payee.official_domains.map((d) => d.domain));
      for (const { group, fact } of facts) {
        const host = extractHost(fact.source_url as string)!;
        const onOwnSite = [...ownDomains].some((domain) => hostMatchesDomain(host, domain));
        expect(onOwnSite, `${payee.id}.${group} cites ${host}`).toBe(true);
      }
    });

    it('quotes the phone number it lists', () => {
      for (const phone of payee.phones) {
        const digits = phoneDigits(phone.number)!;
        expect(digits, phone.number).toHaveLength(10);
        expect(phone.quote.replace(/\D/g, ''), `${payee.id} phone ${phone.number}`).toContain(digits);
      }
    });

    it('quotes the domain it lists', () => {
      for (const domain of payee.official_domains) {
        expect(domain.quote.toLowerCase(), `${payee.id} domain ${domain.domain}`).toContain(domain.domain);
      }
    });
  });
});

describe('findPayeeByName', () => {
  it.each([
    ['IRS', 'irs'],
    ['the I.R.S.', 'irs'],
    ['an IRS agent', 'irs'],
    ['Social Security', 'ssa'],
    ['Medicare Premium Collection Center', 'medicare'],
    ['PG&E', 'pge'],
    ['Pacific Gas and Electric Company', 'pge'],
    ['ConEd', 'con-edison'],
    ['Florida Power & Light', 'fpl'],
    ['the post office', 'usps'],
  ])('resolves %s', (name, id) => {
    expect(findPayeeByName(registry, name)?.id).toBe(id);
  });

  it.each(['Greenleaf Roofing', 'Portland General Electric (PGE)', 'First Bank', 'Duke University', 'my friend Iris'])(
    'does not resolve %s',
    (name) => {
      expect(findPayeeByName(registry, name)).toBeUndefined();
    },
  );
});

describe('verifyPayee', () => {
  it('verifies a payee whose supplied details agree with the registry', () => {
    const result = verifyPayee(registry, [], { name: 'Con Edison', phone: '1 (800) 752-6633', url: 'https://www.coned.com/en/accounts-billing' });
    expect(result.status).toBe('verified');
    expect(result.matches).toEqual(['name', 'url', 'phone']);
    expect(result.official?.phones[0]?.number).toBe('1-800-752-6633');
  });

  it('accepts a vanity spelling of an official number', () => {
    expect(verifyPayee(registry, [], { name: 'Medicare', phone: '1-800-MEDICARE' }).matches).toContain('phone');
  });

  it('reports a mismatch for a link that is not on the official site, without repeating it', () => {
    const result = verifyPayee(registry, [], { name: 'IRS', url: 'https://irs-taxpayer-relief.com/pay' });
    expect(result.status).toBe('mismatch');
    expect(result.mismatches[0]).toMatchObject({ field: 'url', code: 'url_not_official', severity: 'high' });
    expect(JSON.stringify(result)).not.toContain('irs-taxpayer-relief');
  });

  it('recognises a lookalike domain even when no payee is named', () => {
    const result = verifyPayee(registry, [], { url: 'usps-redelivery.example.com/track' });
    expect(result.registry_id).toBe('usps');
    expect(result.mismatches[0]?.code).toBe('lookalike_domain');
  });

  it('resolves the payee from an official link alone', () => {
    const result = verifyPayee(registry, [], { url: 'https://sa.www4.irs.gov/irfof/lang/en/irfofgetstatus.jsp' });
    expect(result).toMatchObject({ status: 'verified', registry_id: 'irs' });
  });

  it('flags a phone number that is not on file as a soft mismatch, without repeating it', () => {
    const result = verifyPayee(registry, [], { name: 'Social Security', phone: '888-555-0142' });
    expect(result.status).toBe('mismatch');
    expect(result.mismatches[0]).toMatchObject({ field: 'phone', code: 'phone_not_on_file', severity: 'medium' });
    expect(JSON.stringify(result)).not.toContain('555');
  });

  it('does not invent a phone mismatch when the registry has no number on file', () => {
    const result = verifyPayee(registry, [], { name: 'Duke Energy', phone: '888-555-0142' });
    expect(result.status).toBe('verified');
    expect(result.official?.phones).toEqual([]);
  });

  it('flags a payment method the organisation says it never uses', () => {
    const result = verifyPayee(registry, [], { name: 'Con Edison', payment_method: 'zelle' });
    expect(result.mismatches[0]).toMatchObject({ field: 'payment_method', code: 'method_never_used', severity: 'high' });
    expect(result.mismatches[0]?.source?.url).toContain('coned.com');
    // `fact` is the registry's own summary, copied as it is, for showing as a short list item.
    const never = registry.byId.get('con-edison')!.never_methods[0]!;
    expect(result.mismatches[0]?.fact).toBe(never.summary);
  });

  it('gives a plain comparison no registry fact of its own', () => {
    expect(verifyPayee(registry, [], { name: 'IRS', phone: '888-555-0142' }).mismatches[0]?.fact).toBeUndefined();
    expect(verifyPayee(registry, [], { name: 'IRS', url: 'https://irs-pay.example.com' }).mismatches[0]?.fact).toBeUndefined();
    const ftc = verifyPayee(registry, [], { name: 'FTC' }).mismatches[0]!;
    expect(ftc.fact).toBe(registry.byId.get('ftc')!.contact_facts[0]!.summary);
  });

  it('treats any request to pay the FTC as a mismatch, because the FTC never asks for money', () => {
    const result = verifyPayee(registry, [], { name: 'FTC refund department' });
    expect(result.status).toBe('mismatch');
    expect(result.mismatches[0]?.code).toBe('never_asks_for_money');
  });

  it('checks a mailing address when one is on file', () => {
    const good = verifyPayee(registry, [], { name: 'Medicare', address: 'Medicare Premium Collection Center, P.O. Box 790355, St. Louis MO 63179-0355' });
    expect(good.matches).toContain('address');
    const bad = verifyPayee(registry, [], { name: 'Medicare', address: 'PO Box 1234, Miami FL 33101' });
    expect(bad.mismatches[0]?.code).toBe('address_not_on_file');
  });

  it('answers not_in_registry honestly for an unknown payee', () => {
    const result = verifyPayee(registry, [], { name: 'Greenleaf Roofing', phone: '888-555-0142' });
    expect(result.status).toBe('not_in_registry');
    expect(result.official).toBeUndefined();
    expect(result.note).toMatch(/not in the registry/);
  });

  it('never echoes a phone number or link hidden in the payee name', () => {
    const result = verifyPayee(registry, [], { name: 'Officer Daniels 888-555-0142 at fedpay-secure.com' });
    expect(result.status).toBe('not_in_registry');
    expect(containsActionableContact(JSON.stringify(result))).toBe(false);
  });

  it('recognises a payee the family has vouched for, by exact name only', () => {
    const trusted = [{ name: 'Greenleaf Roofing', normalized_name: 'greenleaf roofing', added_by: 'Sarah Ellis', added_at: '2026-10-11T00:00:00.000Z' }];
    expect(verifyPayee(registry, trusted, { name: 'greenleaf roofing' }).status).toBe('family_trusted');
    expect(verifyPayee(registry, trusted, { name: 'Greenleaf Roofing and Solar' }).status).toBe('not_in_registry');
  });

  it('is deterministic', () => {
    const query = { name: 'PG&E', phone: '1-877-660-6789', url: 'pge.com', payment_method: 'card' as const };
    expect(verifyPayee(registry, [], query)).toEqual(verifyPayee(registry, [], query));
  });
});
