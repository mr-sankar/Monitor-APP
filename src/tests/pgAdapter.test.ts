import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sqliteToPostgresSql } from '../db/pgAdapter.js';

describe('PostgreSQL SQL Dialect Converter Tests', () => {
  it('converts parameter placeholders from ? to $1, $2, ...', () => {
    const input = 'SELECT * FROM devices WHERE id = ? AND last_seen_at > ? AND status = ?';
    const output = sqliteToPostgresSql(input);
    assert.strictEqual(output, 'SELECT * FROM devices WHERE id = $1 AND last_seen_at > $2 AND status = $3');
  });

  it('preserves ? inside string literals', () => {
    const input = "SELECT * FROM devices WHERE hostname = 'Is this a question?' AND id = ?";
    const output = sqliteToPostgresSql(input);
    assert.strictEqual(output, "SELECT * FROM devices WHERE hostname = 'Is this a question?' AND id = $1");
  });

  it('converts INSERT OR IGNORE INTO to ON CONFLICT DO NOTHING', () => {
    const input = 'INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, ?, ?);';
    const output = sqliteToPostgresSql(input);
    assert.strictEqual(output, 'INSERT INTO roles (id, name, description) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;');
  });

  it('does not duplicate ON CONFLICT if already present', () => {
    const input = `
      INSERT INTO daily_summaries (id, date, device_id) VALUES (?, ?, ?)
      ON CONFLICT(date, device_id, employee_id) DO UPDATE SET updated_at = NOW()
    `;
    const output = sqliteToPostgresSql(input);
    assert.ok(!output.includes('DO NOTHING'), 'Should not append DO NOTHING when ON CONFLICT is explicitly defined');
    assert.ok(output.includes('$1') && output.includes('$2') && output.includes('$3'));
  });

  it('strips PRAGMA statements', () => {
    const input = 'PRAGMA journal_mode = WAL;';
    const output = sqliteToPostgresSql(input);
    assert.ok(output.startsWith('-- PRAGMA'));
  });

  it('converts datetime("now") to ISO timestamp literal', () => {
    const input = "INSERT INTO employees (created_at) VALUES (datetime('now'))";
    const output = sqliteToPostgresSql(input);
    assert.ok(output.includes("INSERT INTO employees (created_at) VALUES ('20"));
  });
});
