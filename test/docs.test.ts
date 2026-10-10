/** Keeps the README and the Agent Skill honest about what the code and data actually contain. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../src/domain/registry.js';
import { loadRules } from '../src/domain/rules.js';
import { packagePath } from '../src/paths.js';
import { CONTACT_TOKEN, MEMBER_TOKEN, connect, startTestServer } from './helpers.js';

const readme = readFileSync(packagePath('README.md'), 'utf8');
const skill = readFileSync(packagePath('skills', 'holdon-money-safety', 'SKILL.md'), 'utf8');
const statistics = JSON.parse(readFileSync(packagePath('rules', 'statistics.json'), 'utf8')) as {
  statistics: Array<{ id: string; statement: string; source_url: string; quote: string; quote_context?: string; checked: string }>;
};

async function toolNames(): Promise<{ member: string[]; contact: string[] }> {
  const t = await startTestServer();
  try {
    const member = await connect(t.url, MEMBER_TOKEN);
    const contact = await connect(t.url, CONTACT_TOKEN);
    const names = {
      member: (await member.listTools()).tools.map((tool) => tool.name),
      contact: (await contact.listTools()).tools.map((tool) => tool.name),
    };
    await member.close();
    await contact.close();
    return names;
  } finally {
    await t.close();
  }
}

describe('README', () => {
  it('lists every source the data files cite', () => {
    const urls = new Set<string>();
    for (const payee of loadRegistry().payees) {
      for (const group of [payee.official_domains, payee.phones, payee.addresses, payee.accepted_methods, payee.never_methods, payee.contact_facts]) {
        for (const fact of group) urls.add(fact.source_url);
      }
    }
    for (const pattern of loadRules().patterns) for (const source of pattern.guidance) urls.add(source.source_url);
    for (const stat of statistics.statistics) urls.add(stat.source_url);
    for (const url of urls) expect(readme, url).toContain(url);
  });

  it('documents every tool, and only tools that exist', async () => {
    const { member, contact } = await toolNames();
    for (const name of [...member, ...contact]) expect(readme, name).toContain(`\`${name}\``);
    const documented = new Set(readme.match(/holdon_[a-z_]+/g));
    expect([...documented].sort()).toEqual([...member, ...contact].sort());
  });

  it('only quotes figures that are recorded with a source', () => {
    const recorded = statistics.statistics.map((s) => `${s.quote} ${s.quote_context ?? ''}`).join(' ');
    for (const figure of ['201,266', '$7.748', '59%', '$38,500', '12,444']) {
      expect(readme).toContain(figure);
      expect(recorded, figure).toContain(figure);
    }
    for (const stat of statistics.statistics) {
      expect(stat.source_url).toMatch(/^https:\/\//);
      expect(stat.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(stat.quote.trim().split(/\s+/).length).toBeLessThan(25);
    }
  });

  it('only shows screenshots that are in the repository', () => {
    const images = [...readme.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]!);
    expect(images.length).toBeGreaterThanOrEqual(3);
    for (const image of images) {
      expect(image, image).toMatch(/^docs\/screenshots\/[a-z0-9-]+\.png$/);
      expect(existsSync(packagePath(...image.split('/'))), image).toBe(true);
    }
  });

  it('says that payments are simulated and that the project is unofficial', () => {
    expect(readme).toMatch(/All payments are simulated/);
    expect(readme).toMatch(/not affiliated with/);
    expect(readme).toContain('```mermaid');
  });
});

describe('Agent Skill', () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const field = (name: string) => frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();

  it('has valid Agent Skills frontmatter', () => {
    const name = field('name');
    expect(name).toBe('holdon-money-safety');
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name!.length).toBeLessThanOrEqual(64);
    const description = field('description')!;
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(skill.split('\n').length).toBeLessThan(500);
  });

  it('only refers to tools that exist', async () => {
    const { member, contact } = await toolNames();
    const known = new Set([...member, ...contact]);
    for (const name of new Set(skill.match(/holdon_[a-z_]+/g))) {
      if (name === 'holdon_') continue;
      expect(known.has(name), name).toBe(true);
    }
  });

  it('covers the rules that matter most', () => {
    expect(skill).toMatch(/Never repeat a phone number, link/);
    expect(skill).toMatch(/keep it secret/i);
    expect(skill).toMatch(/frightened|upset/);
    expect(skill).toMatch(/simulated/);
  });
});
