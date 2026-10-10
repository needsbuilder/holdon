/**
 * MCP Apps: small `ui://` cards that a host can render next to a tool result.
 *
 *   ui://holdon/hold-card.html      the older adult's hold card
 *   ui://holdon/receipt-card.html   the receipt for a simulated payment
 *   ui://holdon/approval-card.html  the trusted contact's Approve / Deny card
 *
 * Tools point at a card through `_meta.ui.resourceUri`. Hosts without MCP Apps
 * support ignore the metadata and use the text and structured result as usual.
 */
import { existsSync, readFileSync } from 'node:fs';
import { RESOURCE_MIME_TYPE, registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Role } from '../domain/types.js';
import { packagePath } from '../paths.js';

export const UI = {
  hold: 'ui://holdon/hold-card.html',
  receipt: 'ui://holdon/receipt-card.html',
  approval: 'ui://holdon/approval-card.html',
} as const;

interface Card {
  uri: string;
  file: string;
  name: string;
  description: string;
  role: Role;
}

const CARDS: Card[] = [
  {
    uri: UI.hold,
    file: 'hold-card.html',
    name: 'Hold card',
    description: 'Shows one hold in large type: its status, the amount and payee, and what the trusted contact said. Contains no links and nothing taken from the suspicious message.',
    role: 'member',
  },
  {
    uri: UI.receipt,
    file: 'receipt-card.html',
    name: 'Receipt card',
    description: 'Shows the receipt for a simulated payment.',
    role: 'member',
  },
  {
    uri: UI.approval,
    file: 'approval-card.html',
    name: 'Family approval card',
    description: 'Shows a request with its warning signs and official sources, with Approve and Deny buttons that call holdon_family_decide through the host.',
    role: 'contact',
  },
];

const cache = new Map<string, string>();

const NOT_BUILT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hold On</title></head><body><p>This card has not been built yet. Run <code>npm run build</code> on the server.</p></body></html>`;

/** The built single-file HTML for a card. Built by `npm run build` (scripts/build-ui.mjs). */
export function readCardHtml(file: string): string {
  const cached = cache.get(file);
  if (cached) return cached;
  const path = packagePath('dist', 'ui', file);
  if (!existsSync(path)) return NOT_BUILT;
  const html = readFileSync(path, 'utf8');
  cache.set(file, html);
  return html;
}

/** Attach a card to a tool definition. */
export function withCard<C extends object>(config: C, resourceUri: string): C & { _meta: { ui: { resourceUri: string } } } {
  return { ...config, _meta: { ui: { resourceUri } } };
}

export function registerCards(server: McpServer, role: Role): void {
  for (const card of CARDS.filter((c) => c.role === role)) {
    registerAppResource(
      server,
      card.name,
      card.uri,
      // The cards load nothing from the network, so no CSP domains are requested.
      { description: card.description, _meta: { ui: { prefersBorder: true } } },
      () => ({
        contents: [{ uri: card.uri, mimeType: RESOURCE_MIME_TYPE, text: readCardHtml(card.file), _meta: { ui: { prefersBorder: true } } }],
      }),
    );
  }
}
