import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

export interface IDatabaseSync {
  prepare(sql: string): IStatementSync;
  exec(sql: string): void;
}

export interface IStatementSync {
  all(...params: any[]): any[];
  get(...params: any[]): any | undefined;
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
}

/**
 * Transforms SQLite SQL dialect to PostgreSQL SQL dialect:
 * 1. Converts ? parameter placeholders to $1, $2, $3, ...
 * 2. Converts INSERT OR IGNORE INTO ... to INSERT INTO ... ON CONFLICT DO NOTHING
 * 3. Strips PRAGMA statements
 * 4. Replaces datetime('now') with NOW()
 */
export function sqliteToPostgresSql(sql: string): string {
  let transformed = sql.trim();

  // Strip PRAGMAs
  if (/^PRAGMA\s+/i.test(transformed)) {
    return '-- PRAGMA ignored in PostgreSQL';
  }

  // Handle INSERT OR IGNORE
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(transformed)) {
    transformed = transformed.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
    if (!/ON\s+CONFLICT/i.test(transformed)) {
      if (transformed.endsWith(';')) {
        transformed = transformed.slice(0, -1).trim() + ' ON CONFLICT DO NOTHING;';
      } else {
        transformed = transformed + ' ON CONFLICT DO NOTHING';
      }
    }
  }

  // Handle INSERT OR REPLACE
  if (/INSERT\s+OR\s+REPLACE\s+INTO/i.test(transformed)) {
    transformed = transformed.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO');
  }

  // Replace datetime('now') with an ISO timestamp string literal
  transformed = transformed.replace(/datetime\('now'\)/gi, `'${new Date().toISOString()}'`);

  // Convert ? to $1, $2, etc. (skipping inside string literals)
  let paramIdx = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let result = '';

  for (let i = 0; i < transformed.length; i++) {
    const char = transformed[i];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      result += char;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += char;
    } else if (char === '?' && !inSingleQuote && !inDoubleQuote) {
      paramIdx++;
      result += `$${paramIdx}`;
    } else {
      result += char;
    }
  }

  return result;
}

// Worker script that executes queries against PostgreSQL
const PG_WORKER_SCRIPT = `
  const { parentPort, workerData } = require('node:worker_threads');
  const pg = require('pg');

  // Parse COUNT(*) and bigint values as standard JS numbers instead of strings
  pg.types.setTypeParser(20, (val) => parseInt(val, 10));

  const connectionString = workerData.connectionString;
  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

  const pool = new pg.Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
  });

  let clientInstance = null;

  async function getClient() {
    if (!clientInstance) {
      clientInstance = await pool.connect();
      clientInstance.on('error', (err) => {
        console.error('[PostgreSQL Worker Client ERROR]:', err.message);
        clientInstance = null;
      });
    }
    return clientInstance;
  }

  parentPort.on('message', async (msg) => {
    const { type, sql, params, port, sab } = msg;
    const flag = new Int32Array(sab);

    try {
      if (sql.startsWith('-- PRAGMA')) {
        port.postMessage({ success: true, rows: [], rowCount: 0 });
      } else if (type === 'exec') {
        const client = await getClient();
        await client.query(sql);
        port.postMessage({ success: true });
      } else {
        const client = await getClient();
        const res = await client.query(sql, params || []);
        port.postMessage({
          success: true,
          rows: res.rows || [],
          rowCount: typeof res.rowCount === 'number' ? res.rowCount : 0
        });
      }
    } catch (err) {
      // If client died, reset it
      if (err.code === 'ECONNRESET' || err.code === '57P01') {
        clientInstance = null;
      }
      port.postMessage({
        success: false,
        error: err.message || String(err),
        code: err.code
      });
    } finally {
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0, 1);
    }
  });
`;

export class PostgresAdapter implements IDatabaseSync {
  private worker: Worker;
  private sab: SharedArrayBuffer;
  private flag: Int32Array;

  constructor(connectionString: string) {
    this.sab = new SharedArrayBuffer(4);
    this.flag = new Int32Array(this.sab);

    this.worker = new Worker(PG_WORKER_SCRIPT, {
      eval: true,
      workerData: { connectionString }
    });

    this.worker.on('error', (err) => {
      console.error('[PostgresAdapter Worker Fatal Error]:', err);
    });

    console.log('[PostgreSQL] Connected to persistent PostgreSQL database via synchronous adapter.');
  }

  private callWorker(type: 'query' | 'exec', sql: string, params?: any[]): any {
    const { port1, port2 } = new MessageChannel();
    this.flag[0] = 0;

    // Normalize params (convert undefined to null)
    const cleanParams = params ? params.map(p => (p === undefined ? null : p)) : [];

    this.worker.postMessage(
      { type, sql, params: cleanParams, port: port2, sab: this.sab },
      [port2]
    );

    // Wait up to 45 seconds for query execution
    const waitResult = Atomics.wait(this.flag, 0, 0, 45000);
    if (waitResult === 'timed-out') {
      port1.close();
      throw new Error(`[PostgreSQL Query Timeout] Execution exceeded 45s for SQL: ${sql.slice(0, 120)}...`);
    }

    const received = receiveMessageOnPort(port1);
    port1.close();

    if (!received || !received.message) {
      throw new Error('[PostgreSQL Bridge Error] No response received from worker thread');
    }

    const res = received.message;
    if (!res.success) {
      throw new Error(`[PostgreSQL Error]: ${res.error} (SQL: ${sql.slice(0, 150)})`);
    }

    return res;
  }

  prepare(sql: string): IStatementSync {
    const pgSql = sqliteToPostgresSql(sql);
    const self = this;

    return {
      all(...params: any[]): any[] {
        const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const res = self.callWorker('query', pgSql, flatParams);
        return res.rows;
      },
      get(...params: any[]): any | undefined {
        const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const res = self.callWorker('query', pgSql, flatParams);
        return res.rows.length > 0 ? res.rows[0] : undefined;
      },
      run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
        const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const res = self.callWorker('query', pgSql, flatParams);
        return { changes: res.rowCount, lastInsertRowid: 0 };
      }
    };
  }

  exec(sql: string): void {
    // Multi-statement DDL support
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      const pgSql = sqliteToPostgresSql(stmt);
      if (pgSql.startsWith('-- PRAGMA')) continue;
      this.callWorker('exec', pgSql);
    }
  }

  close(): void {
    this.worker.terminate();
  }
}
