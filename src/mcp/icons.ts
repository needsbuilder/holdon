/**
 * Tool icons (MCP 2025-11-25 `icons`), inlined as SVG data URIs so the server
 * needs no static file hosting. Plain, high-contrast shapes on a dark tile.
 */
interface Icon {
  src: string;
  mimeType: string;
  sizes: string[];
}

function tile(body: string, background = '#12305b'): Icon[] {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">` +
    `<rect width="48" height="48" rx="10" fill="${background}"/>` +
    `<g fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
  return [{ src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] }];
}

export const ICONS = {
  /** Shield with a tick: checking a request or a payee. */
  check: tile('<path d="M24 8l13 5v10c0 9-5.5 14.5-13 17-7.5-2.5-13-8-13-17V13z"/><path d="M18 24l4.5 4.5L31 20"/>'),
  /** Pause bars: placing or viewing a hold. */
  hold: tile('<circle cx="24" cy="24" r="15"/><path d="M20 17v14M28 17v14"/>', '#7a4a00'),
  /** Clock: waiting for a decision. */
  wait: tile('<circle cx="24" cy="24" r="15"/><path d="M24 15v9l6 4"/>', '#7a4a00'),
  /** Receipt: a simulated payment. */
  pay: tile('<path d="M14 9h20v30l-5-3-5 3-5-3-5 3z"/><path d="M19 18h10M19 25h10"/>', '#14532d'),
  /** Cross in a circle: cancelling. */
  cancel: tile('<circle cx="24" cy="24" r="15"/><path d="M18 18l12 12M30 18L18 30"/>', '#5b1a1a'),
  /** Two people: the trusted contact's tools. */
  family: tile('<circle cx="18" cy="18" r="5"/><circle cx="32" cy="20" r="4"/><path d="M8 38c0-6 4.5-10 10-10s10 4 10 10M30 29c5 0 9 3 9 9"/>', '#3b1f6b'),
  /** Sliders: policy. */
  policy: tile('<path d="M10 16h28M10 32h28"/><circle cx="19" cy="16" r="4" fill="#3b1f6b"/><circle cx="30" cy="32" r="4" fill="#3b1f6b"/>', '#3b1f6b'),
} as const;
