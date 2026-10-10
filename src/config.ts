import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { packagePath } from './paths.js';

export interface Config {
  host: string;
  port: number;
  /** Base URL used in approval links, e.g. https://holdon.example.org. Defaults to the local address. */
  publicUrl?: string;
  dbPath: string;
  /** HMAC key for approval links and webhook signatures. */
  secret: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  webhookUrl?: string;
  progressIntervalMs: number;
}

function list(value: string | undefined): string[] | undefined {
  const items = value?.split(',').map((item) => item.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

/**
 * The signing secret comes from HOLDON_SECRET. Without it, a random key is
 * generated once and kept next to the database (never in the repository), so
 * approval links survive a restart.
 */
export function loadSecret(dbPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOLDON_SECRET && env.HOLDON_SECRET.length >= 16) return env.HOLDON_SECRET;
  if (dbPath === ':memory:') return randomBytes(32).toString('hex');
  const file = join(dirname(dbPath), 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dbPath = env.HOLDON_DB ?? packagePath('data', 'holdon.db');
  const port = Number(env.PORT ?? env.HOLDON_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  return {
    host: env.HOLDON_HOST ?? '127.0.0.1',
    port,
    publicUrl: env.HOLDON_PUBLIC_URL?.replace(/\/$/, ''),
    dbPath,
    secret: loadSecret(dbPath, env),
    allowedHosts: list(env.HOLDON_ALLOWED_HOSTS),
    allowedOrigins: list(env.HOLDON_ALLOWED_ORIGINS),
    webhookUrl: env.HOLDON_WEBHOOK_URL,
    progressIntervalMs: Number(env.HOLDON_PROGRESS_INTERVAL_MS ?? 2000),
  };
}
