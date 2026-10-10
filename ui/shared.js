// Shared code for the Hold On cards (MCP Apps views).
//
// Every card is a small, self-contained page that a host renders in a sandboxed
// iframe. Safety rules for this file:
//   - text is only ever written with textContent, never as HTML
//   - nothing loads from the network
//   - the only links are official source links on the trusted contact's card
//     (https pages cited in the rules and registry files), and they are opened
//     by asking the host, never by navigating the card. Nothing that came from
//     a suspicious message is ever a link, and the older adult's cards have none
//   - the cards only show what the server returned for this person's role
//
// The cards talk to the host with the MCP Apps protocol (JSON-RPC 2.0 over
// postMessage, specification 2026-01-26). The few messages a card needs are
// written out below instead of bundling an SDK, which keeps each card a few
// kilobytes and easy to audit. test/apps.test.ts runs every card against the
// official host implementation, AppBridge from @modelcontextprotocol/ext-apps.

const APPS_PROTOCOL_VERSION = '2026-01-26';
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Minimal MCP Apps view: handshake, tool results from the host, and tool calls
 * through the host. Messages are only accepted from the embedding window.
 */
export async function connectHost({ name, version, onToolResult }) {
  const host = window.parent;
  const pending = new Map();
  let nextId = 1;

  const post = (message) => host.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const notify = (method, params) => post({ method, params });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      post({ id, method, params });
    });

  window.addEventListener('message', (event) => {
    if (event.source !== host) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;

    if (message.method === undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'Request failed'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id === undefined) {
      if (message.method === 'ui/notifications/tool-result') onToolResult(message.params);
      return;
    }
    // Requests from the host: agree to be torn down, answer pings, decline anything else.
    if (message.method === 'ui/resource-teardown' || message.method === 'ping') post({ id: message.id, result: {} });
    else post({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  });

  const initialized = await request('ui/initialize', {
    appInfo: { name, version },
    appCapabilities: {},
    protocolVersion: APPS_PROTOCOL_VERSION,
  });
  notify('ui/notifications/initialized', {});

  // Let the host size the iframe to the card.
  const reportSize = () => {
    const box = document.documentElement;
    notify('ui/notifications/size-changed', { width: Math.ceil(box.scrollWidth), height: Math.ceil(box.scrollHeight) });
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.body);
  reportSize();

  return {
    hostContext: initialized?.hostContext,
    hostCapabilities: initialized?.hostCapabilities ?? {},
    callTool: (tool, args) => request('tools/call', { name: tool, arguments: args }),
    // MCP Apps `ui/open-link`: the host decides whether and how to open it.
    openLink: (url) => request('ui/open-link', { url }),
  };
}

export const SIMULATED = 'Demonstration only: payments are simulated and no real money moves.';

/** Create an element. Children are strings (written as text) or other elements. */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function usd(amount) {
  if (typeof amount !== 'number') return undefined;
  const cents = Math.round(amount * 100) % 100 !== 0;
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
}

const METHODS = {
  gift_card: 'Gift cards',
  crypto: 'Cryptocurrency',
  wire: 'Wire transfer',
  zelle: 'Zelle',
  payment_app: 'Payment app',
  cash: 'Cash',
  check: 'Check',
  card: 'Credit or debit card',
  bank_transfer: 'Bank account',
  unknown: 'Not specified',
};
export const methodName = (method) => METHODS[method] ?? 'Not specified';

const CHANNELS = {
  phone_call: 'Phone call',
  text: 'Text message',
  email: 'Email',
  mail: 'Postal mail',
  in_person: 'In person',
  website: 'Website or pop-up',
};
export const channelName = (channel) => CHANNELS[channel];

export function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** "consumer.ftc.gov" for "https://consumer.ftc.gov/articles/...": a short, honest label for a source link. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * A link to an official source, labelled with its website. Only https pages
 * are linked, and only when the host can open links; otherwise the website is
 * shown as plain text. The card itself never navigates.
 */
export function sourceLink(source, api) {
  const site = source?.url ? hostOf(source.url) : undefined;
  if (!site) return undefined;
  const name = [source.publisher, source.title].filter(Boolean).join(', ');
  if (!api.canOpenLinks || !/^https:\/\//.test(source.url)) return el('span', { class: 'source', title: name }, site);
  return el(
    'a',
    {
      class: 'source',
      href: source.url,
      rel: 'noreferrer noopener',
      title: name,
      'aria-label': `Source: ${name || site}`,
      onclick: (event) => {
        event.preventDefault();
        api.openLink(source.url).catch(() => undefined);
      },
    },
    site,
  );
}

/** A two-column list of facts; rows without a value are left out. */
export function facts(rows) {
  const list = el('dl', { class: 'facts' });
  for (const [term, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    list.append(el('dt', {}, term), el('dd', {}, value));
  }
  return list;
}

export function textOf(result) {
  return (result?.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Connect to the host and re-render whenever a tool result arrives.
 * `render(root, structuredContent, api)` draws the card; `api.call` runs a
 * server tool through the host and resolves with the standard tool result.
 */
export async function start(name, render) {
  const root = document.getElementById('root');
  let host;
  const api = {
    call: (tool, args) => host.callTool(tool, args),
    openLink: (url) => host.openLink(url),
    get canOpenLinks() {
      return Boolean(host?.hostCapabilities?.openLinks);
    },
    show,
  };

  function show(result) {
    root.replaceChildren();
    if (!result || result.isError || !result.structuredContent) {
      const message = textOf(result) || 'There is nothing to show yet.';
      root.append(el('section', { class: 'card caution' }, el('p', { class: 'lead', role: 'status' }, message)), el('p', { class: 'small' }, SIMULATED));
      return;
    }
    render(root, result.structuredContent, api);
    root.append(el('p', { class: 'small' }, SIMULATED));
  }

  host = await connectHost({ name, version: '0.1.0', onToolResult: show });
  return host;
}
