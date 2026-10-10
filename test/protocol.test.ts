/**
 * Protocol-level checks against the running HTTP server, using raw JSON-RPC
 * over fetch so that nothing in a client SDK can hide what is on the wire.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTACT_TOKEN, MEMBER_TOKEN, connect, startTestServer, type TestServer } from './helpers.js';

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(async () => {
  await t.close();
});

interface RpcReply {
  status: number;
  headers: Headers;
  messages: Array<Record<string, any>>;
}

/** POST one JSON-RPC message and collect every message of the reply, whether it came as JSON or as an SSE stream. */
async function rpc(body: unknown, options: { token?: string; session?: string; version?: string } = {}): Promise<RpcReply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.session) headers['Mcp-Session-Id'] = options.session;
  if (options.version) headers['MCP-Protocol-Version'] = options.version;
  const response = await fetch(`${t.url}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  const messages = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .map((data) => JSON.parse(data) as Record<string, any>)
    : text
      ? [JSON.parse(text) as Record<string, any>]
      : [];
  return { status: response.status, headers: response.headers, messages };
}

const initialize = (protocolVersion: string, capabilities: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion, capabilities, clientInfo: { name: 'raw-test-client', version: '1.0.0' } },
});

describe('MCP 2025-11-25 over Streamable HTTP', () => {
  it('negotiates protocol version 2025-11-25 when the client asks for it', async () => {
    const reply = await rpc(initialize('2025-11-25'), { token: MEMBER_TOKEN });

    expect(reply.status).toBe(200);
    expect(reply.messages).toHaveLength(1);
    const message = reply.messages[0]!;
    expect(message).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(message.error).toBeUndefined();
    expect(message.result.protocolVersion).toBe('2025-11-25');
    expect(message.result.serverInfo).toMatchObject({ name: 'holdon', title: 'Hold On' });
    expect(message.result.capabilities.tools).toBeDefined();
    expect(typeof message.result.instructions).toBe('string');
    // Streamable HTTP: the session id comes back in a header and is required afterwards.
    expect(reply.headers.get('mcp-session-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves tools/list and tools/call on that session with the 2025-11-25 header', async () => {
    const init = await rpc(initialize('2025-11-25'), { token: MEMBER_TOKEN });
    const session = init.headers.get('mcp-session-id')!;
    const version = '2025-11-25';
    const ack = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { token: MEMBER_TOKEN, session, version });
    expect(ack.status).toBe(202);

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { token: MEMBER_TOKEN, session, version });
    const tools = list.messages[0]!.result.tools as Array<Record<string, any>>;
    expect(tools.map((tool) => tool.name)).toContain('holdon_check_request');
    const check = tools.find((tool) => tool.name === 'holdon_check_request')!;
    // 2025-11-25 features: icons, title, annotations and an output schema on every tool.
    expect(check.icons[0]).toMatchObject({ mimeType: 'image/svg+xml' });
    expect(check.icons[0].src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(check.annotations).toMatchObject({ readOnlyHint: true });
    expect(check.outputSchema.properties.verdict.enum).toEqual(['stop', 'hold_for_family', 'verified', 'unknown']);
    expect(check.inputSchema.required).toEqual(['description']);

    const called = await rpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'holdon_verify_payee', arguments: { name: 'IRS', url: 'irs.gov' } } },
      { token: MEMBER_TOKEN, session, version },
    );
    const result = called.messages.find((message) => message.id === 3)!.result;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'verified', registry_id: 'irs' });
    expect(result.content[0].type).toBe('text');
  });

  it('answers with a version it supports when the client asks for one it does not know', async () => {
    const reply = await rpc(initialize('1999-01-01'), { token: MEMBER_TOKEN });
    expect(reply.status).toBe(200);
    expect(reply.messages[0]!.result.protocolVersion).toBe('2025-11-25');
  });

  it('still serves an older 2025 client at its own version', async () => {
    const reply = await rpc(initialize('2025-06-18'), { token: MEMBER_TOKEN });
    expect(reply.messages[0]!.result.protocolVersion).toBe('2025-06-18');
  });

  it('rejects requests without a valid bearer token before any MCP processing', async () => {
    const missing = await rpc(initialize('2025-11-25'));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer /);
    const wrong = await rpc(initialize('2025-11-25'), { token: 'not-a-real-token' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toMatch(/invalid_token/);
  });

  it('requires initialize first, and rejects unknown or borrowed sessions', async () => {
    const noSession = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { token: MEMBER_TOKEN });
    expect(noSession.status).toBe(400);
    const unknown = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { token: MEMBER_TOKEN, session: '00000000-0000-4000-8000-000000000000' });
    expect(unknown.status).toBe(404);

    const init = await rpc(initialize('2025-11-25'), { token: MEMBER_TOKEN });
    const borrowed = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { token: CONTACT_TOKEN, session: init.headers.get('mcp-session-id')!, version: '2025-11-25' });
    expect(borrowed.status).toBe(403);
  });

  it('ends a session on DELETE', async () => {
    const init = await rpc(initialize('2025-11-25'), { token: MEMBER_TOKEN });
    const session = init.headers.get('mcp-session-id')!;
    const closed = await fetch(`${t.url}/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${MEMBER_TOKEN}`, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-11-25' } });
    expect(closed.status).toBe(200);
    const after = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { token: MEMBER_TOKEN, session, version: '2025-11-25' });
    expect(after.status).toBe(404);
  });

  it('answers malformed JSON with a JSON-RPC parse error', async () => {
    const response = await fetch(`${t.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${MEMBER_TOKEN}` },
      body: '{"jsonrpc": "2.0", ',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe('SDK clients', () => {
  it('a 2025-style client negotiates 2025-11-25', async () => {
    const client = await connect(t.url, MEMBER_TOKEN);
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getServerVersion()).toMatchObject({ name: 'holdon' });
    await client.close();
  });

  it('a client that probes for the newer revision is served 2026-07-28 from the same tools', async () => {
    const client = await connect(t.url, MEMBER_TOKEN, { mode: 'auto' });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('holdon_check_request');
    const result = await client.callTool({ name: 'holdon_verify_payee', arguments: { name: 'Medicare', phone: '1-800-MEDICARE' } });
    expect(result.structuredContent).toMatchObject({ status: 'verified', registry_id: 'medicare' });
    await client.close();
  });
});

describe('browser clients', () => {
  it('answers a CORS preflight from a local simulator and exposes the session header', async () => {
    const preflight = await fetch(`${t.url}/mcp`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version,mcp-session-id' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('mcp-session-id');

    const response = await fetch(`${t.url}/mcp`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${MEMBER_TOKEN}` },
      body: JSON.stringify(initialize('2025-11-25')),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-expose-headers')).toContain('Mcp-Session-Id');
    await response.text();
  });

  it('refuses a browser origin that is not allowed', async () => {
    const response = await fetch(`${t.url}/mcp`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${MEMBER_TOKEN}` },
      body: JSON.stringify(initialize('2025-11-25')),
    });
    expect(response.status).toBe(403);
  });

  it('reports health without a token', async () => {
    const response = await fetch(`${t.url}/healthz`);
    expect(await response.json()).toMatchObject({ ok: true, name: 'holdon' });
  });
});
