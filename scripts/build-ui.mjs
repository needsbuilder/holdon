#!/usr/bin/env node
// Builds the MCP Apps cards: each ui/*-card.js is bundled with ui/shared.js
// into one classic script and inlined, with the shared stylesheet, into a
// single HTML file in dist/ui/. The result needs nothing from the network,
// which is what a sandboxed MCP Apps iframe allows by default.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'ui');

export const CARDS = [
  { file: 'hold-card.html', entry: 'hold-card.js', title: 'Hold On: hold' },
  { file: 'approval-card.html', entry: 'approval-card.js', title: 'Hold On: family approval', htmlClass: 'compact' },
  { file: 'receipt-card.html', entry: 'receipt-card.js', title: 'Hold On: receipt' },
];

export async function buildUi({ quiet = false } = {}) {
  mkdirSync(outDir, { recursive: true });
  const css = readFileSync(join(root, 'ui', 'card.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  for (const card of CARDS) {
    const result = await build({
      entryPoints: [join(root, 'ui', card.entry)],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      minify: true,
      legalComments: 'none',
      write: false,
      logLevel: 'error',
    });
    // An inline script ends at the first "</script", wherever it appears.
    const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
    const html = `<!doctype html>
<html lang="en"${card.htmlClass ? ` class="${card.htmlClass}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no, email=no, address=no">
<title>${card.title}</title>
<style>
${css}
</style>
</head>
<body>
<main id="root" aria-live="polite"><p class="lead">One moment...</p></main>
<script>
${script}
</script>
</body>
</html>
`;
    writeFileSync(join(outDir, card.file), html);
    if (!quiet) console.log(`built dist/ui/${card.file} (${Math.round(html.length / 1024)} kB)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildUi();
}
