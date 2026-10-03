import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { PostgresAdapter, IDatabaseSync } from './pgAdapter.js';

let dbInstance: IDatabaseSync;

const pgUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGDATABASE_URL;

if (pgUrl) {
  console.log('[Database] DATABASE_URL detected. Initializing PostgreSQL adapter...');
  dbInstance = new PostgresAdapter(pgUrl);
} else {
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = process.env.DB_PATH || path.join(dataDir, 'productivity.db');
  const sqlite = new DatabaseSync(dbPath);

  // Enable WAL mode for high concurrency
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA synchronous = NORMAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA busy_timeout = 10000;');

  dbInstance = sqlite as unknown as IDatabaseSync;
}

export const db = dbInstance;

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      permissions_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS administrators (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role_id TEXT NOT NULL REFERENCES roles(id),
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      emp_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      department TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      device_identifier TEXT UNIQUE NOT NULL,
      hostname TEXT NOT NULL,
      os_version TEXT NOT NULL,
      serial_number TEXT,
      mac_address TEXT,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      secret_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revoked_devices (
      id TEXT PRIMARY KEY,
      device_identifier TEXT UNIQUE,
      hostname TEXT,
      reason TEXT,
      revoked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_assignments (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      employee_id TEXT NOT NULL REFERENCES employees(id),
      assigned_at TEXT NOT NULL,
      unassigned_at TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS device_live_status (
      device_id TEXT PRIMARY KEY REFERENCES devices(id),
      app_name TEXT,
      process_name TEXT,
      window_title TEXT,
      domain TEXT,
      start_time TEXT,
      last_sample_time TEXT,
      duration_seconds INTEGER,
      is_idle INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      color TEXT NOT NULL,
      is_work INTEGER NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS category_rules (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES categories(id),
      match_type TEXT NOT NULL, -- 'domain', 'process', 'keyword'
      pattern TEXT NOT NULL,
      priority INTEGER DEFAULT 10
    );

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      process_name TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      category_id TEXT REFERENCES categories(id),
      is_blocked INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY,
      domain TEXT UNIQUE NOT NULL,
      category_id TEXT REFERENCES categories(id),
      is_blocked INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS work_schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      work_start_time TEXT NOT NULL,
      work_end_time TEXT NOT NULL,
      work_days TEXT NOT NULL, -- e.g. "1,2,3,4,5"
      break_start_time TEXT,
      break_end_time TEXT,
      timezone TEXT DEFAULT 'UTC',
      is_default INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      employee_id TEXT NOT NULL REFERENCES employees(id),
      event_type TEXT NOT NULL, -- 'app', 'web', 'idle'
      process_name TEXT NOT NULL,
      app_name TEXT NOT NULL,
      domain TEXT,
      window_title_sanitized TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      is_idle INTEGER DEFAULT 0,
      is_working_hours INTEGER DEFAULT 1,
      category_id TEXT NOT NULL REFERENCES categories(id),
      synced_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_activity_device_time ON activity_events(device_id, start_time);
    CREATE INDEX IF NOT EXISTS idx_activity_employee_time ON activity_events(employee_id, start_time);
    CREATE INDEX IF NOT EXISTS idx_activity_start_time ON activity_events(start_time);
    CREATE INDEX IF NOT EXISTS idx_activity_time_device ON activity_events(start_time, device_id);
    CREATE INDEX IF NOT EXISTS idx_activity_category ON activity_events(category_id);
    CREATE INDEX IF NOT EXISTS idx_activity_domain ON activity_events(domain);
    CREATE INDEX IF NOT EXISTS idx_activity_working_hours ON activity_events(is_working_hours);

    CREATE TABLE IF NOT EXISTS daily_summaries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      device_id TEXT NOT NULL REFERENCES devices(id),
      employee_id TEXT NOT NULL REFERENCES employees(id),
      total_time_seconds INTEGER DEFAULT 0,
      active_time_seconds INTEGER DEFAULT 0,
      idle_time_seconds INTEGER DEFAULT 0,
      work_time_seconds INTEGER DEFAULT 0,
      non_work_time_seconds INTEGER DEFAULT 0,
      youtube_seconds INTEGER DEFAULT 0,
      social_media_seconds INTEGER DEFAULT 0,
      entertainment_seconds INTEGER DEFAULT 0,
      category_breakdown_json TEXT,
      top_apps_json TEXT,
      top_domains_json TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(date, device_id, employee_id)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_summaries(date);
    CREATE INDEX IF NOT EXISTS idx_daily_employee ON daily_summaries(employee_id);

    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rule_type TEXT NOT NULL, -- 'youtube_excessive', 'non_work_percentage', 'blocked_domain', 'device_offline'
      threshold_value REAL NOT NULL,
      window_minutes INTEGER DEFAULT 60,
      severity TEXT NOT NULL, -- 'low', 'medium', 'high', 'critical'
      is_enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      alert_rule_id TEXT REFERENCES alert_rules(id),
      device_id TEXT REFERENCES devices(id),
      employee_id TEXT REFERENCES employees(id),
      triggered_at TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      status TEXT DEFAULT 'open', -- 'open', 'acknowledged', 'resolved'
      resolved_by TEXT,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE INDEX IF NOT EXISTS idx_alerts_triggered ON alerts(triggered_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT,
      admin_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_entity TEXT NOT NULL,
      target_id TEXT,
      ip_address TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO employees (id, emp_code, name, email, department, status, created_at)
    VALUES ('emp-unassigned', 'EMP-UNASSIGNED', 'Unassigned Hardware Pool', 'unassigned@devices.internal', 'IT Staging', 'active', '2026-01-01T00:00:00.000Z');

    INSERT OR IGNORE INTO categories (id, name, color, is_work, description) VALUES
      ('cat-dev', 'Development', '#10b981', 1, 'Code editors, IDEs, terminals, Git repos'),
      ('cat-comm', 'Communication', '#3b82f6', 1, 'Slack, Teams, Outlook, Zoom'),
      ('cat-prod', 'Productivity', '#6366f1', 1, 'Word, Excel, Notion, Docs, Sheets, Project management'),
      ('cat-work', 'Work', '#0ea5e9', 1, 'General work-related business applications'),
      ('cat-youtube', 'YouTube', '#ef4444', 0, 'YouTube video streaming'),
      ('cat-social', 'Social Media', '#f59e0b', 0, 'Facebook, Twitter/X, Instagram, LinkedIn, Reddit'),
      ('cat-ent', 'Entertainment', '#ec4899', 0, 'Netflix, Spotify, Twitch, Games, Streaming'),
      ('cat-shop', 'Shopping', '#8b5cf6', 0, 'E-commerce and shopping portals'),
      ('cat-other', 'Other', '#6b7280', 0, 'Uncategorized or system utilities');
  `);
}

// Auto-initialize tables immediately so any subsequent module imports have ready schema
try {
  initDatabase();
} catch (err) {
  console.error('[Database Auto-Init Error]:', err);
}
