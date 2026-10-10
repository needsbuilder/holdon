/**
 * HTTP wiring: the MCP endpoint (Streamable HTTP), the live event stream, and
 * the family approval page.
 *
 *   POST/GET/DELETE /mcp          MCP over Streamable HTTP, bearer token required
 *   GET             /events       Server-Sent Events for holds, bearer token required
 *   GET/POST        /approve/:id  Signed web page where the trusted contact decides
 *   GET             /healthz      Liveness
 *
 * Two protocol eras are served from the same tool definitions:
 * - 2025-11-25 and earlier 2025 revisions: the `initialize` handshake with a
 *   session, so the server can ask the client a question (elicitation) and
 *   stream progress on the same connection.
 * - 2026-07-28: stateless per-request serving through `createMcpHandler`.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
  type AuthInfo,
  type McpServer,
} from '@modelcontextprotocol/server';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { renderApprovalPage, renderMessagePage, signApprovalToken, verifyApprovalToken } from '../approval.js';
import { SIMULATED_NOTE } from '../domain/language.js';
import type { Principal } from '../domain/types.js';
import { SERVER_NAME, SERVER_VERSION, buildMcpServer } from '../mcp/server.js';
import { HoldOnError, type HoldOnService, type ServiceEvent } from '../service.js';

export interface AppOptions {
  service: HoldOnService;
  /** HMAC key for approval links and webhook signatures. */
  secret: string;
  host?: string;
  /** Base URL for approval links. When omitted it is taken from the listening address. */
  publicUrl?: string;
  allowedHosts?: string[];
  /** Extra origin hostnames (beyond localhost) allowed to call the server from a browser. */
  allowedOrigins?: string[];
  webhookUrl?: string;
  /** Print each new hold's signed approval link to the log, so the demo works with only a browser. Default true. */
  logApprovalLinks?: boolean;
  progressIntervalMs?: number;
  sessionIdleMs?: number;
  log?: (line: string) => void;
}

interface Session {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
  lastSeen: number;
}

export interface HoldOnApp {
  app: Express;
  sessions: Map<string, Session>;
  setPublicUrl(url: string): void;
  close(): Promise<void>;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim() || undefined;
  return undefined;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/** The event as each kind of listener may see it. Members never receive the approval link or untrusted details. */
export function renderEvent(service: HoldOnService, event: ServiceEvent, principal: Principal): Record<string, unknown> | undefined {
  const base = { id: event.id, type: event.type, at: event.created_at, circle_id: event.circle_id };
  if (event.type === 'policy.updated') {
    return principal.role === 'contact' ? { ...base, circle: service.circleView(event.circle_id) } : undefined;
  }
  const hold = event.hold_id ? service.store.getHold(event.hold_id) : undefined;
  if (!hold) return undefined;
  if (principal.role === 'contact') return { ...base, hold: service.familyHoldView(hold, principal.user_id) };
  if (hold.member_id !== principal.user_id) return undefined;
  return { ...base, hold: service.memberHoldView(hold) };
}

export function createHoldOnApp(options: AppOptions): HoldOnApp {
  const { service, secret } = options;
  const log = options.log ?? (() => undefined);
  const host = options.host ?? '127.0.0.1';
  let publicUrl = options.publicUrl ?? `http://localhost`;

  service.webhookEnabled = Boolean(options.webhookUrl);
  service.approvalUrl = (holdId, contactUserId) =>
    `${publicUrl}/approve/${encodeURIComponent(holdId)}?t=${signApprovalToken(secret, holdId, contactUserId)}`;

  const app = createMcpExpressApp({
    host,
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    ...(options.allowedOrigins ? { allowedOrigins: [...LOCAL_HOSTNAMES, ...options.allowedOrigins] } : {}),
    jsonLimit: '256kb',
  });
  app.disable('x-powered-by');

  // --- CORS, so a browser-based simulator can act as a real MCP client ------
  const originAllowed = (origin: string): boolean => {
    try {
      const hostname = new URL(origin).hostname;
      return LOCAL_HOSTNAMES.has(hostname) || LOCAL_HOSTNAMES.has(`[${hostname}]`) || (options.allowedOrigins ?? []).includes(hostname);
    } catch {
      return false;
    }
  };
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          req.headers['access-control-request-headers'] ?? 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        );
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
      }
    }
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  app.get('/', (_req, res) => {
    res.json({
      name: 'Hold On',
      version: SERVER_VERSION,
      about: 'Money-safety MCP server with family approval. Not affiliated with Amazon.',
      payments: SIMULATED_NOTE,
      mcp: { endpoint: '/mcp', transport: 'streamable-http', protocol_versions: [...SUPPORTED_PROTOCOL_VERSIONS, '2026-07-28'], auth: 'Bearer token' },
      events: { endpoint: '/events', format: 'text/event-stream', auth: 'Bearer token (or ?access_token= for EventSource)' },
    });
  });

  // --- MCP -------------------------------------------------------------------
  const sessions = new Map<string, Session>();
  const mcpOptions = {
    progressIntervalMs: options.progressIntervalMs,
    onError: (error: unknown, tool: string) => log(`tool ${tool} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
  };

  const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    const principal = token ? service.authenticate(token) : undefined;
    if (!token || !principal) {
      res.setHeader('WWW-Authenticate', `Bearer realm="${SERVER_NAME}"${token ? ', error="invalid_token"' : ''}`);
      jsonRpcError(res, 401, -32001, token ? 'Unauthorized: this bearer token is not recognised.' : 'Unauthorized: send an "Authorization: Bearer <token>" header.');
      return;
    }
    const auth: AuthInfo = { token, clientId: principal.user_id, scopes: [`holdon:${principal.role}`], extra: { principal } };
    (req as Request & { auth?: AuthInfo }).auth = auth;
    next();
  };
  const principalOf = (auth: AuthInfo | undefined): Principal => {
    const principal = (auth?.extra as { principal?: Principal } | undefined)?.principal;
    if (!principal) throw new Error('Request reached the MCP server without an authenticated principal.');
    return principal;
  };

  const modern = createMcpHandler((ctx) => buildMcpServer(service, principalOf(ctx.authInfo), mcpOptions), {
    legacy: 'reject',
    onerror: (error) => log(`mcp: ${error.message}`),
  });
  const modernNode = toNodeHandler(modern, { onerror: (error) => log(`mcp: ${error.message}`) });

  app.all('/mcp', authenticate, async (req: Request, res: Response) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth;
    const principal = principalOf(auth);
    try {
      const body: unknown = req.method === 'POST' ? req.body : undefined;
      const probe = await toWebRequest(req, body);
      if (!(await isLegacyRequest(probe, body))) {
        await modernNode(req, res, body);
        return;
      }

      // 2025-era traffic: one transport and one server instance per session.
      const sessionId = req.headers['mcp-session-id'];
      const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      let session = sid ? sessions.get(sid) : undefined;
      if (sid && !session) {
        jsonRpcError(res, 404, -32001, 'Session not found. Send a new initialize request.');
        return;
      }
      if (!session) {
        const messages = Array.isArray(body) ? body : [body];
        if (req.method !== 'POST' || !messages.some((message) => isInitializeRequest(message))) {
          jsonRpcError(res, 400, -32000, 'Bad Request: start with an initialize request, then send the Mcp-Session-Id header it returns.');
          return;
        }
        const server = buildMcpServer(service, principal, mcpOptions);
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
          },
        });
        const created: Session = { transport, server, userId: principal.user_id, lastSeen: Date.now() };
        session = created;
        await server.connect(transport);
      }
      if (session.userId !== principal.user_id) {
        jsonRpcError(res, 403, -32001, 'Forbidden: this session belongs to a different user.');
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      log(`mcp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error.');
    }
  });

  const idleMs = options.sessionIdleMs ?? 30 * 60_000;
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        void session.server.close().catch(() => undefined);
      }
    }
    try {
      service.sweepExpired();
    } catch (error) {
      log(`sweep: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 30_000);
  sweeper.unref();

  // --- live events -----------------------------------------------------------
  const streams = new Set<Response>();
  app.get('/events', (req: Request, res: Response) => {
    const queryToken = typeof req.query.access_token === 'string' ? req.query.access_token : undefined;
    const token = bearerToken(req) ?? queryToken;
    const principal = token ? service.authenticate(token) : undefined;
    if (!principal) {
      res.setHeader('WWW-Authenticate', `Bearer realm="${SERVER_NAME}"`);
      res.status(401).json({ error: 'unauthorized', message: 'Send an "Authorization: Bearer <token>" header, or ?access_token= when using EventSource.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (name: string, data: unknown, id?: number) => {
      res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    send('ready', {
      user: { id: principal.user_id, name: principal.name, role: principal.role },
      circle_id: principal.circle_id,
      server_time: new Date().toISOString(),
    });

    const deliver = (event: ServiceEvent) => {
      if (event.circle_id !== principal.circle_id) return;
      const payload = renderEvent(service, event, principal);
      if (payload) send(event.type, payload, event.id);
    };
    const lastHeader = req.headers['last-event-id'];
    const lastQuery = typeof req.query.last_event_id === 'string' ? req.query.last_event_id : undefined;
    const last = Number(Array.isArray(lastHeader) ? lastHeader[0] : (lastHeader ?? lastQuery));
    if (Number.isInteger(last) && last >= 0 && (lastHeader !== undefined || lastQuery !== undefined)) {
      for (const missed of service.store.listEventsAfter(principal.circle_id, last)) deliver(missed as ServiceEvent);
    }

    service.events.on('event', deliver);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    streams.add(res);
    req.on('close', () => {
      clearInterval(heartbeat);
      service.events.off('event', deliver);
      streams.delete(res);
    });
  });

  // --- notifications to the trusted contact -----------------------------------
  const notify = (event: ServiceEvent) => {
    const contact = service.store.listUsers(event.circle_id, 'contact')[0];
    if (!contact) return;
    const hold = event.hold_id ? service.store.getHold(event.hold_id) : undefined;
    if (event.type === 'hold.created' && hold) {
      const link = options.logApprovalLinks === false ? '' : `\n  ${contact.name} can decide at ${service.approvalUrl(hold.id, contact.id)}`;
      log(`hold placed: ${service.headline(hold)}${link}`);
    }
    if (!options.webhookUrl) return;
    const payload = renderEvent(service, event, service.principalOf(contact));
    if (!payload) return;
    const body = JSON.stringify(payload);
    fetch(options.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HoldOn-Event': event.type,
        'X-HoldOn-Signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch((error: unknown) => log(`webhook failed: ${error instanceof Error ? error.message : String(error)}`));
  };
  service.events.on('event', notify);

  // --- family approval page ---------------------------------------------------
  const pageHeaders = (res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    // `same-origin`, not `no-referrer`: with `no-referrer` a browser submits the
    // form with `Origin: null`, which the Origin check above (rightly) refuses,
    // so Approve and Deny would do nothing. The signed link still never leaves
    // this server: no Referer is sent to any other origin.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  };
  const contactFromLink = (holdId: string, token: string | undefined): Principal | undefined => {
    const userId = verifyApprovalToken(secret, token, holdId);
    const user = userId ? service.store.getUser(userId) : undefined;
    return user && user.role === 'contact' ? service.principalOf(user) : undefined;
  };
  const invalidLink = (res: Response) => {
    res.status(403).type('html').send(
      renderMessagePage('This link cannot be used', 'This approval link is not valid or has expired. Ask your family member to start the request again, or open the newest link you were sent.', 'stop'),
    );
  };

  app.get('/approve/:holdId', (req: Request, res: Response) => {
    pageHeaders(res);
    const holdId = String(req.params.holdId);
    const token = typeof req.query.t === 'string' ? req.query.t : undefined;
    const principal = contactFromLink(holdId, token);
    if (!principal || !token) return invalidLink(res);
    try {
      const hold = service.familyHold(principal, holdId);
      // `done` is set by the redirect after a button press; the page then also says what happens next.
      const justDecided = req.query.done === 'approved' || req.query.done === 'denied';
      res.type('html').send(renderApprovalPage(service.familyHoldView(hold, principal.user_id), { token, justDecided }));
    } catch (error) {
      if (error instanceof HoldOnError) {
        res.status(404).type('html').send(renderMessagePage('Request not found', error.message, 'caution'));
        return;
      }
      throw error;
    }
  });

  app.post('/approve/:holdId', express.urlencoded({ extended: false, limit: '16kb' }), (req: Request, res: Response) => {
    pageHeaders(res);
    const holdId = String(req.params.holdId);
    const form = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof form.t === 'string' ? form.t : undefined;
    const principal = contactFromLink(holdId, token);
    if (!principal || !token) return invalidLink(res);
    const decision = form.decision === 'approve' || form.decision === 'deny' ? form.decision : undefined;
    const note = typeof form.note === 'string' && form.note.trim() ? form.note.trim().slice(0, 500) : undefined;
    try {
      if (!decision) throw new HoldOnError('invalid_input', 'Choose Approve or Deny.');
      service.familyDecide(principal, { hold_id: holdId, decision, note, trust_payee: form.trust_payee === 'true' });
      res.redirect(303, `/approve/${encodeURIComponent(holdId)}?t=${encodeURIComponent(token)}&done=${decision === 'approve' ? 'approved' : 'denied'}`);
    } catch (error) {
      if (!(error instanceof HoldOnError)) throw error;
      let message =
        error.code === 'payee_not_verified'
          ? 'To approve a payee that is not in the official registry, tick the box saying you personally know and trust them. Otherwise choose Deny.'
          : error.message;
      try {
        const hold = service.familyHold(principal, holdId);
        // The page lists the reasons one by one; do not repeat them here as a paragraph.
        if (error.code === 'blocked' && hold.blocked) message = 'This request was stopped and cannot be approved. The reasons are listed below.';
        res.status(409).type('html').send(renderApprovalPage(service.familyHoldView(hold, principal.user_id), { token, error: message }));
      } catch {
        res.status(404).type('html').send(renderMessagePage('Request not found', message, 'caution'));
      }
    }
  });

  // Malformed JSON and anything unexpected: answer in JSON, never with a stack trace.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const parseFailed = typeof error === 'object' && error !== null && (error as { type?: string }).type === 'entity.parse.failed';
    if (!parseFailed) log(`http: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (res.headersSent) return;
    if (parseFailed) jsonRpcError(res, 400, -32700, 'Parse error: the request body is not valid JSON.');
    else if (req.path.startsWith('/approve')) res.status(500).type('html').send(renderMessagePage('Something went wrong', 'Nothing was changed. Please try again.', 'caution'));
    else jsonRpcError(res, 500, -32603, 'Internal server error.');
  });

  return {
    app,
    sessions,
    setPublicUrl(url: string) {
      publicUrl = url.replace(/\/$/, '');
    },
    async close() {
      clearInterval(sweeper);
      service.events.off('event', notify);
      for (const stream of streams) stream.end();
      streams.clear();
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((session) => session.server.close()));
      await modern.close().catch(() => undefined);
    },
  };
}

export interface RunningServer {
  url: string;
  port: number;
  app: HoldOnApp;
  close(): Promise<void>;
}

export async function startHoldOnServer(options: AppOptions & { port?: number }): Promise<RunningServer> {
  const holdon = createHoldOnApp(options);
  const host = options.host ?? '127.0.0.1';
  const server: HttpServer = await new Promise((resolve, reject) => {
    const listening = holdon.app.listen(options.port ?? 0, host, () => resolve(listening));
    listening.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  const displayHost = host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
  const url = `http://${displayHost}:${port}`;
  holdon.setPublicUrl(options.publicUrl ?? url);
  return {
    url,
    port,
    app: holdon,
    async close() {
      await holdon.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
