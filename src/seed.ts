#!/usr/bin/env node
/**
 * Creates the demo circle: Margaret Ellis (the older adult) and her daughter
 * Sarah Ellis (the trusted contact), with the default policy.
 *
 *   npm run seed            add or refresh the demo circle, keep existing holds
 *   npm run seed:reset      wipe the database first
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { DEFAULT_POLICY, PAYMENT_METHODS, ROLES } from './domain/types.js';
import { packagePath } from './paths.js';
import { hashToken } from './service.js';
import { Store } from './store/db.js';

const SeedSchema = z.object({
  circle: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  users: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        role: z.enum(ROLES),
        relationship: z.string().optional(),
        token: z.string().min(8),
      }),
    )
    .min(1),
  policy: z
    .object({
      approval_threshold_usd: z.number().min(0),
      blocked_methods_official_payees: z.array(z.enum(PAYMENT_METHODS)),
      blocked_methods_all_payees: z.array(z.enum(PAYMENT_METHODS)),
      hold_expiry_hours: z.number().int().min(1),
      notify_on_stop: z.boolean(),
    })
    .partial()
    .optional(),
});
export type SeedFile = z.infer<typeof SeedSchema>;

export function loadSeedFile(path = process.env.HOLDON_SEED_FILE ?? packagePath('seed', 'demo-circle.json')): SeedFile {
  return SeedSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Write the circle, its people and its policy. Tokens are stored only as SHA-256 hashes. */
export function seedStore(store: Store, seed: SeedFile = loadSeedFile(), options: { reset?: boolean } = {}): void {
  const now = new Date().toISOString();
  store.transaction(() => {
    if (options.reset) store.reset();
    store.upsertCircle({ id: seed.circle.id, name: seed.circle.name, policy: { ...DEFAULT_POLICY, ...seed.policy } }, now);
    for (const user of seed.users) {
      store.upsertUser(
        { id: user.id, circle_id: seed.circle.id, name: user.name, role: user.role, relationship: user.relationship, token_hash: hashToken(user.token) },
        now,
      );
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const seed = loadSeedFile();
  const reset = process.argv.includes('--reset');
  seedStore(store, seed, { reset });
  store.close();
  console.log(`${reset ? 'Reset and seeded' : 'Seeded'} ${config.dbPath}`);
  console.log(`Circle: ${seed.circle.name}`);
  for (const user of seed.users) {
    console.log(`  ${user.role.padEnd(7)} ${user.name.padEnd(16)} token: ${user.token}`);
  }
}
