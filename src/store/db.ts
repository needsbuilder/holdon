/**
 * SQLite persistence using Node's built-in `node:sqlite`.
 *
 * Holds, decisions and receipts live here so that state survives across
 * assistant sessions and server restarts: a hold placed in one conversation
 * can be approved from a browser and paid in another conversation.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  CheckInput,
  CheckOutcome,
  HoldStatus,
  PaymentMethod,
  Policy,
  Role,
  TrustedPayee,
} from '../domain/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS circles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'contact')),
  relationship TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trusted_payees (
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  name TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (circle_id, normalized_name)
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  check_id TEXT NOT NULL REFERENCES checks(id),
  summary TEXT NOT NULL,
  amount_cents INTEGER,
  payee_name TEXT,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  decision_by TEXT,
  decision_by_name TEXT,
  decision_at TEXT,
  decision_note TEXT,
  receipt_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS holds_by_circle ON holds (circle_id, status, created_at);
CREATE INDEX IF NOT EXISTS holds_by_check ON holds (check_id);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  hold_id TEXT NOT NULL UNIQUE REFERENCES holds(id),
  circle_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  payee TEXT NOT NULL,
  method TEXT NOT NULL,
  confirmation TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id TEXT NOT NULL,
  type TEXT NOT NULL,
  hold_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_circle ON events (circle_id, id);
`;

export interface CircleRow {
  id: string;
  name: string;
  policy: Policy;
  created_at: string;
}

export interface UserRow {
  id: string;
  circle_id: string;
  name: string;
  role: Role;
  relationship?: string;
}

export interface CheckRow {
  id: string;
  circle_id: string;
  member_id: string;
  input: CheckInput;
  outcome: CheckOutcome;
  created_at: string;
}

export interface HoldRow {
  id: string;
  circle_id: string;
  member_id: string;
  check_id: string;
  summary: string;
  amount_cents?: number;
  payee_name?: string;
  payment_method: PaymentMethod;
  status: HoldStatus;
  blocked: boolean;
  decision_by?: string;
  decision_by_name?: string;
  decision_at?: string;
  decision_note?: string;
  receipt_id?: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface ReceiptRow {
  id: string;
  hold_id: string;
  circle_id: string;
  amount_cents: number;
  payee: string;
  method: PaymentMethod;
  confirmation: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  circle_id: string;
  type: string;
  hold_id?: string;
  created_at: string;
}

type Row = Record<string, unknown>;

const optional = <T>(value: unknown): T | undefined => (value === null || value === undefined ? undefined : (value as T));

function toHold(row: Row): HoldRow {
  return {
    id: row.id as string,
    circle_id: row.circle_id as string,
    member_id: row.member_id as string,
    check_id: row.check_id as string,
    summary: row.summary as string,
    amount_cents: optional<number>(row.amount_cents),
    payee_name: optional<string>(row.payee_name),
    payment_method: row.payment_method as PaymentMethod,
    status: row.status as HoldStatus,
    blocked: row.blocked === 1,
    decision_by: optional<string>(row.decision_by),
    decision_by_name: optional<string>(row.decision_by_name),
    decision_at: optional<string>(row.decision_at),
    decision_note: optional<string>(row.decision_note),
    receipt_id: optional<string>(row.receipt_id),
    created_at: row.created_at as string,
    expires_at: row.expires_at as string,
    updated_at: row.updated_at as string,
  };
}

function toUser(row: Row): UserRow {
  return {
    id: row.id as string,
    circle_id: row.circle_id as string,
    name: row.name as string,
    role: row.role as Role,
    relationship: optional<string>(row.relationship),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // --- circles and users -------------------------------------------------

  reset(): void {
    this.db.exec(
      'DELETE FROM events; DELETE FROM receipts; DELETE FROM holds; DELETE FROM checks; DELETE FROM trusted_payees; DELETE FROM users; DELETE FROM circles;',
    );
  }

  upsertCircle(circle: { id: string; name: string; policy: Policy }, now: string): void {
    this.run(
      `INSERT INTO circles (id, name, policy_json, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, policy_json = excluded.policy_json`,
      circle.id,
      circle.name,
      JSON.stringify(circle.policy),
      now,
    );
  }

  upsertUser(user: UserRow & { token_hash: string }, now: string): void {
    this.run(
      `INSERT INTO users (id, circle_id, name, role, relationship, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET circle_id = excluded.circle_id, name = excluded.name, role = excluded.role,
         relationship = excluded.relationship, token_hash = excluded.token_hash`,
      user.id,
      user.circle_id,
      user.name,
      user.role,
      user.relationship ?? null,
      user.token_hash,
      now,
    );
  }

  countUsers(): number {
    return Number(this.get('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
  }

  getCircle(id: string): CircleRow | undefined {
    const row = this.get('SELECT * FROM circles WHERE id = ?', id);
    if (!row) return undefined;
    return {
      id: row.id as string,
      name: row.name as string,
      policy: JSON.parse(row.policy_json as string) as Policy,
      created_at: row.created_at as string,
    };
  }

  setPolicy(circleId: string, policy: Policy): void {
    this.run('UPDATE circles SET policy_json = ? WHERE id = ?', JSON.stringify(policy), circleId);
  }

  getUser(id: string): UserRow | undefined {
    const row = this.get('SELECT * FROM users WHERE id = ?', id);
    return row ? toUser(row) : undefined;
  }

  getUserByTokenHash(tokenHash: string): UserRow | undefined {
    const row = this.get('SELECT * FROM users WHERE token_hash = ?', tokenHash);
    return row ? toUser(row) : undefined;
  }

  listUsers(circleId: string, role?: Role): UserRow[] {
    const rows = role
      ? this.all('SELECT * FROM users WHERE circle_id = ? AND role = ? ORDER BY created_at, id', circleId, role)
      : this.all('SELECT * FROM users WHERE circle_id = ? ORDER BY created_at, id', circleId);
    return rows.map(toUser);
  }

  // --- trusted payees ----------------------------------------------------

  listTrustedPayees(circleId: string): TrustedPayee[] {
    return this.all('SELECT * FROM trusted_payees WHERE circle_id = ? ORDER BY added_at, name', circleId).map((row) => ({
      name: row.name as string,
      normalized_name: row.normalized_name as string,
      added_by: row.added_by as string,
      added_at: row.added_at as string,
      note: optional<string>(row.note),
    }));
  }

  addTrustedPayee(circleId: string, payee: TrustedPayee): void {
    this.run(
      `INSERT INTO trusted_payees (circle_id, normalized_name, name, added_by, added_at, note) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(circle_id, normalized_name) DO NOTHING`,
      circleId,
      payee.normalized_name,
      payee.name,
      payee.added_by,
      payee.added_at,
      payee.note ?? null,
    );
  }

  removeTrustedPayee(circleId: string, normalizedName: string): boolean {
    return this.run('DELETE FROM trusted_payees WHERE circle_id = ? AND normalized_name = ?', circleId, normalizedName).changes > 0;
  }

  // --- checks ------------------------------------------------------------

  insertCheck(check: CheckRow): void {
    this.run(
      'INSERT INTO checks (id, circle_id, member_id, input_json, outcome_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      check.id,
      check.circle_id,
      check.member_id,
      JSON.stringify(check.input),
      JSON.stringify(check.outcome),
      check.created_at,
    );
  }

  getCheck(id: string): CheckRow | undefined {
    const row = this.get('SELECT * FROM checks WHERE id = ?', id);
    if (!row) return undefined;
    return {
      id: row.id as string,
      circle_id: row.circle_id as string,
      member_id: row.member_id as string,
      input: JSON.parse(row.input_json as string) as CheckInput,
      outcome: JSON.parse(row.outcome_json as string) as CheckOutcome,
      created_at: row.created_at as string,
    };
  }

  // --- holds -------------------------------------------------------------

  insertHold(hold: HoldRow): void {
    this.run(
      `INSERT INTO holds (id, circle_id, member_id, check_id, summary, amount_cents, payee_name, payment_method, status,
         blocked, decision_by, decision_by_name, decision_at, decision_note, receipt_id, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      hold.id,
      hold.circle_id,
      hold.member_id,
      hold.check_id,
      hold.summary,
      hold.amount_cents ?? null,
      hold.payee_name ?? null,
      hold.payment_method,
      hold.status,
      hold.blocked ? 1 : 0,
      hold.decision_by ?? null,
      hold.decision_by_name ?? null,
      hold.decision_at ?? null,
      hold.decision_note ?? null,
      hold.receipt_id ?? null,
      hold.created_at,
      hold.expires_at,
      hold.updated_at,
    );
  }

  getHold(id: string): HoldRow | undefined {
    const row = this.get('SELECT * FROM holds WHERE id = ?', id);
    return row ? toHold(row) : undefined;
  }

  findOpenHoldByCheck(checkId: string): HoldRow | undefined {
    const row = this.get(
      "SELECT * FROM holds WHERE check_id = ? AND status IN ('pending_family', 'approved', 'paid') ORDER BY created_at DESC LIMIT 1",
      checkId,
    );
    return row ? toHold(row) : undefined;
  }

  listHolds(filter: { circle_id: string; member_id?: string; statuses?: HoldStatus[]; limit: number }): HoldRow[] {
    const where = ['circle_id = ?'];
    const params: SQLInputValue[] = [filter.circle_id];
    if (filter.member_id) {
      where.push('member_id = ?');
      params.push(filter.member_id);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    params.push(filter.limit);
    return this.all(`SELECT * FROM holds WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params).map(toHold);
  }

  listLapsedHolds(now: string): HoldRow[] {
    return this.all("SELECT * FROM holds WHERE status IN ('pending_family', 'approved') AND expires_at <= ?", now).map(toHold);
  }

  /** Update a hold only if it is still in one of the expected states. Returns false when another writer got there first. */
  updateHold(id: string, expected: HoldStatus[], patch: Partial<HoldRow>): boolean {
    const columns = Object.keys(patch).filter((key) => key !== 'id');
    if (columns.length === 0) return false;
    const values = columns.map((column) => {
      const value = (patch as Record<string, unknown>)[column];
      if (typeof value === 'boolean') return value ? 1 : 0;
      return (value ?? null) as SQLInputValue;
    });
    const result = this.run(
      `UPDATE holds SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status IN (${expected.map(() => '?').join(', ')})`,
      ...values,
      id,
      ...expected,
    );
    return result.changes > 0;
  }

  // --- receipts ----------------------------------------------------------

  insertReceipt(receipt: ReceiptRow): void {
    this.run(
      'INSERT INTO receipts (id, hold_id, circle_id, amount_cents, payee, method, confirmation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      receipt.id,
      receipt.hold_id,
      receipt.circle_id,
      receipt.amount_cents,
      receipt.payee,
      receipt.method,
      receipt.confirmation,
      receipt.created_at,
    );
  }

  getReceiptByHold(holdId: string): ReceiptRow | undefined {
    const row = this.get('SELECT * FROM receipts WHERE hold_id = ?', holdId);
    if (!row) return undefined;
    return {
      id: row.id as string,
      hold_id: row.hold_id as string,
      circle_id: row.circle_id as string,
      amount_cents: Number(row.amount_cents),
      payee: row.payee as string,
      method: row.method as PaymentMethod,
      confirmation: row.confirmation as string,
      created_at: row.created_at as string,
    };
  }

  // --- events ------------------------------------------------------------

  insertEvent(event: Omit<EventRow, 'id'>): EventRow {
    const result = this.run(
      'INSERT INTO events (circle_id, type, hold_id, created_at) VALUES (?, ?, ?, ?)',
      event.circle_id,
      event.type,
      event.hold_id ?? null,
      event.created_at,
    );
    return { ...event, id: result.lastInsertRowid };
  }

  listEventsAfter(circleId: string, afterId: number, limit = 200): EventRow[] {
    return this.all('SELECT * FROM events WHERE circle_id = ? AND id > ? ORDER BY id LIMIT ?', circleId, afterId, limit).map((row) => ({
      id: Number(row.id),
      circle_id: row.circle_id as string,
      type: row.type as string,
      hold_id: optional<string>(row.hold_id),
      created_at: row.created_at as string,
    }));
  }
}
