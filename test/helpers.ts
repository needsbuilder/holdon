import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadRegistry } from '../src/domain/registry.js';
import { loadRules } from '../src/domain/rules.js';
import type { EngineContext } from '../src/domain/engine.js';
import { DEFAULT_POLICY, type Policy, type Principal } from '../src/domain/types.js';
import { startHoldOnServer, type RunningServer } from '../src/http/app.js';
import { loadSeedFile, seedStore } from '../src/seed.js';
import { HoldOnService } from '../src/service.js';
import { Store } from '../src/store/db.js';

export const MEMBER_TOKEN = 'demo-member-margaret';
export const CONTACT_TOKEN = 'demo-contact-sarah';
export const TEST_SECRET = 'test-secret-test-secret-test-secret';

export function engineContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    registry: loadRegistry(),
    rules: loadRules(),
    policy: DEFAULT_POLICY,
    trustedPayees: [],
    contactName: 'Sarah Ellis',
    ...overrides,
  };
}

export interface TestClock {
  now: Date;
  advance(ms: number): void;
}

export interface TestService {
  service: HoldOnService;
  store: Store;
  clock: TestClock;
  margaret: Principal;
  sarah: Principal;
}

/** An in-memory database seeded with the demo circle, and a service with a controllable clock. */
export function createTestService(policy: Partial<Policy> = {}): TestService {
  const store = new Store(':memory:');
  const seed = loadSeedFile();
  seedStore(store, { ...seed, policy: { ...seed.policy, ...policy } });
  const clock: TestClock = {
    now: new Date('2026-10-11T15:00:00.000Z'),
    advance(ms) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const service = new HoldOnService({ store, registry: loadRegistry(), rules: loadRules(), clock: () => clock.now });
  return {
    service,
    store,
    clock,
    margaret: service.authenticate(MEMBER_TOKEN)!,
    sarah: service.authenticate(CONTACT_TOKEN)!,
  };
}

export interface TestServer extends TestService {
  server: RunningServer;
  url: string;
  close(): Promise<void>;
}

/** A real HTTP server on a random local port, backed by an in-memory database. */
export async function startTestServer(policy: Partial<Policy> = {}): Promise<TestServer> {
  const store = new Store(':memory:');
  const seed = loadSeedFile();
  seedStore(store, { ...seed, policy: { ...seed.policy, ...policy } });
  const clock: TestClock = {
    now: new Date(),
    advance(ms) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  // Real time by default so that waits and expiry behave as they do in production.
  const service = new HoldOnService({ store, registry: loadRegistry(), rules: loadRules() });
  const server = await startHoldOnServer({ service, secret: TEST_SECRET, port: 0, progressIntervalMs: 40 });
  return {
    service,
    store,
    clock,
    server,
    url: server.url,
    margaret: service.authenticate(MEMBER_TOKEN)!,
    sarah: service.authenticate(CONTACT_TOKEN)!,
    async close() {
      await server.close();
      store.close();
    },
  };
}

export interface ConnectOptions {
  /** Declare form elicitation and answer every question with this content (or decline when null). */
  elicitation?: Record<string, unknown> | null;
  /** 'legacy' negotiates the 2025 handshake (2025-11-25); 'auto' probes for 2026-07-28 first. */
  mode?: 'legacy' | 'auto';
}

export async function connect(url: string, token: string, options: ConnectOptions = {}): Promise<Client & { asked: string[] }> {
  const asked: string[] = [];
  const client = new Client(
    { name: 'holdon-test-client', version: '1.0.0' },
    {
      capabilities: options.elicitation !== undefined ? { elicitation: { form: {} } } : {},
      versionNegotiation: { mode: options.mode ?? 'legacy' },
    },
  ) as Client & { asked: string[] };
  if (options.elicitation !== undefined) {
    client.setRequestHandler('elicitation/create', async (request) => {
      asked.push(request.params.message);
      return options.elicitation === null ? { action: 'decline' } : { action: 'accept', content: options.elicitation as Record<string, string> };
    });
  }
  client.asked = asked;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: { token: async () => token } }));
  return client;
}

/** Call a tool and return its structured content, failing loudly if the tool reported an error. */
export async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`Tool ${name} failed: ${textOf(result)}`);
  return result.structuredContent as T;
}

export function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks.map((block) => block.text ?? '').join('\n');
}

export const SCENARIOS = {
  irsGiftCards: {
    description:
      'A man who said he was an IRS agent called. He says I owe back taxes and a warrant is out for my arrest unless I pay $2,000 in Target gift cards today and read him the numbers. He told me to call back on 1-888-555-0142 and not to tell my daughter.',
    payee_name: 'IRS',
    amount_usd: 2000,
    payment_method: 'gift_card',
    contact_channel: 'phone_call',
    claimed_phone: '1-888-555-0142',
    secrecy_requested: true,
    urgency_claims: ['arrest_or_legal_threat', 'pay_immediately'],
  },
  utilityBill: {
    description: 'My Con Edison electric bill came in the mail and I would like to pay it.',
    payee_name: 'Con Edison',
    amount_usd: 182.4,
    payment_method: 'card',
    contact_channel: 'mail',
  },
  contractorDeposit: {
    description: 'The roofer wants a deposit before he starts on the gutters next week.',
    payee_name: 'Greenleaf Roofing',
    amount_usd: 1500,
    payment_method: 'check',
    contact_channel: 'in_person',
  },
} as const;
