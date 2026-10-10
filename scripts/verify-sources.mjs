#!/usr/bin/env node
// Re-fetches every source_url in registry/payees.json, rules/scam-patterns.json and rules/statistics.json
// and checks that each stored quote (and quote_context) appears verbatim on the page.
//
// Usage: node scripts/verify-sources.mjs [--refresh] [--only <substring>]
//
// Needs network access, `curl`, and (for PDF sources) `pdftotext`. It is not part
// of `npm test` because official sites change and sometimes block automated
// clients; run it by hand before updating the `checked` dates.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, '.cache', 'sources');
const refresh = process.argv.includes('--refresh');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : undefined;

const BASE_ARGS = ['-sS', '-L', '--compressed', '-m', '60'];
const BROWSER_ARGS = [
  '--http2',
  '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  '-H', 'Accept-Language: en-US,en;q=0.9',
  '-H', 'sec-ch-ua: "Chromium";v="129", "Not=A?Brand";v="8"',
  '-H', 'sec-ch-ua-mobile: ?0',
  '-H', 'sec-ch-ua-platform: "macOS"',
  '-H', 'Sec-Fetch-Dest: document',
  '-H', 'Sec-Fetch-Mode: navigate',
  '-H', 'Sec-Fetch-Site: none',
  '-H', 'Sec-Fetch-User: ?1',
  '-H', 'Upgrade-Insecure-Requests: 1',
];
// Official sites disagree about which clients they accept, so try a browser-like
// request first and a plain one second.
const STRATEGIES = [BROWSER_ARGS, []];

function fetchRaw(url) {
  mkdirSync(cacheDir, { recursive: true });
  const key = createHash('sha256').update(url).digest('hex').slice(0, 24);
  const file = join(cacheDir, key + (url.toLowerCase().endsWith('.pdf') ? '.pdf' : '.html'));
  if (!refresh && existsSync(file)) return file;
  let lastStatus = 'no response';
  for (const extra of STRATEGIES) {
    const tmp = `${file}.tmp`;
    try {
      lastStatus = execFileSync('curl', [...BASE_ARGS, ...extra, '-o', tmp, '-w', '%{http_code}', url], { encoding: 'utf8' }).trim();
    } catch (error) {
      lastStatus = error.message.split('\n')[0];
      continue;
    }
    if (lastStatus === '200') {
      renameSync(tmp, file);
      return file;
    }
  }
  throw new Error(`HTTP ${lastStatus}`);
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&reg;/gi, '®')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Compare on letters, digits and punctuation only: whitespace and typographic variants are ignored. */
function squash(text) {
  return text
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/\s+/g, '');
}

function pageTexts(url) {
  const file = fetchRaw(url);
  if (file.endsWith('.pdf')) {
    return ['-layout', '-raw'].map((mode) => execFileSync('pdftotext', [mode, file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  }
  return [htmlToText(readFileSync(file, 'utf8'))];
}

function collect() {
  const facts = [];
  const registry = JSON.parse(readFileSync(join(root, 'registry', 'payees.json'), 'utf8'));
  for (const payee of registry.payees) {
    for (const group of ['official_domains', 'phones', 'addresses', 'accepted_methods', 'never_methods', 'contact_facts']) {
      for (const fact of payee[group] ?? []) facts.push({ where: `registry:${payee.id}:${group}`, ...fact });
    }
  }
  const rulesPath = join(root, 'rules', 'scam-patterns.json');
  if (existsSync(rulesPath)) {
    const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
    for (const pattern of rules.patterns) {
      for (const source of pattern.guidance ?? []) facts.push({ where: `rule:${pattern.id}`, ...source });
    }
  }
  const statsPath = join(root, 'rules', 'statistics.json');
  if (existsSync(statsPath)) {
    const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
    for (const stat of stats.statistics) facts.push({ where: `statistic:${stat.id}`, ...stat });
  }
  return facts;
}

const cache = new Map();
let failed = 0;
let checked = 0;
for (const fact of collect()) {
  if (only && !fact.where.includes(only) && !fact.source_url.includes(only)) continue;
  checked += 1;
  let texts;
  try {
    if (!cache.has(fact.source_url)) cache.set(fact.source_url, pageTexts(fact.source_url).map(squash));
    texts = cache.get(fact.source_url);
  } catch (error) {
    failed += 1;
    console.log(`FETCH FAILED  ${fact.where}\n              ${fact.source_url}\n              ${error.message}`);
    cache.set(fact.source_url, []);
    continue;
  }
  for (const [label, quote] of [['quote', fact.quote], ['quote_context', fact.quote_context]]) {
    if (!quote) continue;
    const ok = texts.some((text) => text.includes(squash(quote)));
    if (!ok) {
      failed += 1;
      console.log(`NOT FOUND     ${fact.where} (${label})\n              ${fact.source_url}\n              "${quote}"`);
    }
  }
}
console.log(`${checked} sourced facts checked against ${cache.size} pages; ${failed} problem(s).`);
process.exit(failed ? 1 : 0);
