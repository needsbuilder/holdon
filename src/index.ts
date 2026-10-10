#!/usr/bin/env node
/**
 * Starts the Hold On server: MCP over Streamable HTTP, the live event stream
 * and the family approval page. Configuration comes from environment
 * variables; see .env.example.
 */
import { loadConfig } from './config.js';
import { loadRegistry } from './domain/registry.js';
import { loadRules } from './domain/rules.js';
import { startHoldOnServer } from './http/app.js';
import { HoldOnService } from './service.js';
import { Store } from './store/db.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const registry = loadRegistry();
  const rules = loadRules();
  const service = new HoldOnService({ store, registry, rules });

  const running = await startHoldOnServer({
    service,
    secret: config.secret,
    host: config.host,
    port: config.port,
    publicUrl: config.publicUrl,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    webhookUrl: config.webhookUrl,
    progressIntervalMs: config.progressIntervalMs,
    log: (line) => console.log(`[holdon] ${line}`),
  });

  console.log(`Hold On is listening on ${running.url}`);
  console.log(`  MCP (Streamable HTTP): ${running.url}/mcp`);
  console.log(`  Live events (SSE):     ${running.url}/events`);
  console.log(`  Registry: ${registry.payees.length} official payees, ${rules.patterns.length} scam patterns (data version ${registry.version})`);
  console.log('  All payments are simulated. No real money moves.');
  if (store.countUsers() === 0) {
    console.log('  No users yet. Run "npm run seed" to create the demo circle, then restart or just connect.');
  }

  const shutdown = async () => {
    await running.close();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
