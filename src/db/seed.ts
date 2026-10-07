import { db, initDatabase } from './database.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

export function seedDatabase() {
  initDatabase();

  // 1. Roles
  const roles = [
    {
      id: 'role-admin',
      name: 'Super Administrator',
      description: 'Full access to all analytics, devices, settings, and audit logs',
      permissions_json: JSON.stringify(['*'])
    },
    {
      id: 'role-manager',
      name: 'Department Manager',
      description: 'Access to department productivity analytics and alerts',
      permissions_json: JSON.stringify(['view_analytics', 'view_reports', 'view_devices', 'manage_alerts'])
    },
    {
      id: 'role-compliance',
      name: 'Compliance Auditor',
      description: 'Access to audit logs, privacy settings, and compliance reports',
      permissions_json: JSON.stringify(['view_analytics', 'view_audit_logs', 'view_reports'])
    }
  ];

  const insertRole = db.prepare(`
    INSERT OR IGNORE INTO roles (id, name, description, permissions_json)
    VALUES (?, ?, ?, ?)
  `);

  for (const r of roles) {
    insertRole.run(r.id, r.name, r.description, r.permissions_json);
  }

  // 2. Administrators
  const adminSalt = bcrypt.genSaltSync(10);
  const adminHash = bcrypt.hashSync('Sankar@990840', adminSalt);
  const nowIso = new Date().toISOString();

  const insertAdmin = db.prepare(`
    INSERT INTO administrators (id, email, password_hash, full_name, role_id, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash, full_name = excluded.full_name
  `);
  insertAdmin.run(
    'admin-1',
    'sankarkella0@gmail.com',
    adminHash,
    'Sankar Kella',
    'role-admin',
    1,
    nowIso
  );

  // 3. Categories
  const categories = [
    { id: 'cat-dev', name: 'Development', color: '#10b981', is_work: 1, description: 'Code editors, IDEs, terminals, Git repos' },
    { id: 'cat-comm', name: 'Communication', color: '#3b82f6', is_work: 1, description: 'Slack, Teams, Outlook, Zoom' },
    { id: 'cat-prod', name: 'Productivity', color: '#6366f1', is_work: 1, description: 'Word, Excel, Notion, Docs, Sheets, Project management' },
    { id: 'cat-work', name: 'Work', color: '#0ea5e9', is_work: 1, description: 'General work-related business applications' },
    { id: 'cat-youtube', name: 'YouTube', color: '#ef4444', is_work: 0, description: 'YouTube video streaming' },
    { id: 'cat-social', name: 'Social Media', color: '#f59e0b', is_work: 0, description: 'Facebook, Twitter/X, Instagram, LinkedIn, Reddit' },
    { id: 'cat-ent', name: 'Entertainment', color: '#ec4899', is_work: 0, description: 'Netflix, Spotify, Twitch, Games, Streaming' },
    { id: 'cat-shop', name: 'Shopping', color: '#8b5cf6', is_work: 0, description: 'E-commerce and shopping portals' },
    { id: 'cat-other', name: 'Other', color: '#6b7280', is_work: 0, description: 'Uncategorized or system utilities' }
  ];

  const insertCategory = db.prepare(`
    INSERT OR IGNORE INTO categories (id, name, color, is_work, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const c of categories) {
    insertCategory.run(c.id, c.name, c.color, c.is_work, c.description);
  }

  // 4. Default Rules
  const rules = [
    // YouTube
    { cat: 'cat-youtube', type: 'domain', pattern: 'youtube.com' },
    { cat: 'cat-youtube', type: 'domain', pattern: 'youtu.be' },
    // Development
    { cat: 'cat-dev', type: 'domain', pattern: 'github.com' },
    { cat: 'cat-dev', type: 'domain', pattern: 'gitlab.com' },
    { cat: 'cat-dev', type: 'domain', pattern: 'stackoverflow.com' },
    { cat: 'cat-dev', type: 'domain', pattern: 'npmjs.com' },
    { cat: 'cat-dev', type: 'process', pattern: 'code.exe' },
    { cat: 'cat-dev', type: 'process', pattern: 'devenv.exe' },
    { cat: 'cat-dev', type: 'process', pattern: 'idea64.exe' },
    { cat: 'cat-dev', type: 'process', pattern: 'windowsterminal.exe' },
    { cat: 'cat-dev', type: 'process', pattern: 'powershell.exe' },
    { cat: 'cat-dev', type: 'process', pattern: 'cmd.exe' },
    // Communication
    { cat: 'cat-comm', type: 'domain', pattern: 'mail.google.com' },
    { cat: 'cat-comm', type: 'domain', pattern: 'outlook.office.com' },
    { cat: 'cat-comm', type: 'domain', pattern: 'web.whatsapp.com' },
    { cat: 'cat-comm', type: 'process', pattern: 'slack.exe' },
    { cat: 'cat-comm', type: 'process', pattern: 'teams.exe' },
    { cat: 'cat-comm', type: 'process', pattern: 'ms-teams.exe' },
    { cat: 'cat-comm', type: 'process', pattern: 'zoom.exe' },
    { cat: 'cat-comm', type: 'process', pattern: 'outlook.exe' },
    // Productivity
    { cat: 'cat-prod', type: 'domain', pattern: 'docs.google.com' },
    { cat: 'cat-prod', type: 'domain', pattern: 'sheets.google.com' },
    { cat: 'cat-prod', type: 'domain', pattern: 'notion.so' },
    { cat: 'cat-prod', type: 'domain', pattern: 'jira.atlassian.com' },
    { cat: 'cat-prod', type: 'domain', pattern: 'confluence.atlassian.com' },
    { cat: 'cat-prod', type: 'domain', pattern: 'linear.app' },
    { cat: 'cat-prod', type: 'process', pattern: 'winword.exe' },
    { cat: 'cat-prod', type: 'process', pattern: 'excel.exe' },
    { cat: 'cat-prod', type: 'process', pattern: 'powerpnt.exe' },
    { cat: 'cat-prod', type: 'process', pattern: 'notion.exe' },
    // Social Media
    { cat: 'cat-social', type: 'domain', pattern: 'facebook.com' },
    { cat: 'cat-social', type: 'domain', pattern: 'twitter.com' },
    { cat: 'cat-social', type: 'domain', pattern: 'x.com' },
    { cat: 'cat-social', type: 'domain', pattern: 'instagram.com' },
    { cat: 'cat-social', type: 'domain', pattern: 'linkedin.com' },
    { cat: 'cat-social', type: 'domain', pattern: 'reddit.com' },
    { cat: 'cat-social', type: 'domain', pattern: 'tiktok.com' },
    // Entertainment
    { cat: 'cat-ent', type: 'domain', pattern: 'netflix.com' },
    { cat: 'cat-ent', type: 'domain', pattern: 'twitch.tv' },
    { cat: 'cat-ent', type: 'domain', pattern: 'spotify.com' },
    { cat: 'cat-ent', type: 'domain', pattern: 'disneyplus.com' },
    { cat: 'cat-ent', type: 'process', pattern: 'spotify.exe' },
    { cat: 'cat-ent', type: 'process', pattern: 'steam.exe' },
    // Shopping
    { cat: 'cat-shop', type: 'domain', pattern: 'amazon.com' },
    { cat: 'cat-shop', type: 'domain', pattern: 'ebay.com' },
    { cat: 'cat-shop', type: 'domain', pattern: 'walmart.com' }
  ];

  const insertRule = db.prepare(`
    INSERT OR IGNORE INTO category_rules (id, category_id, match_type, pattern, priority)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < rules.length; i++) {
    insertRule.run(`rule-${i + 1}`, rules[i].cat, rules[i].type, rules[i].pattern, 10);
  }

  // 5. Work Schedule (24/7 Full-Day WFH tracking)
  const insertSchedule = db.prepare(`
    INSERT OR IGNORE INTO work_schedules (id, name, work_start_time, work_end_time, work_days, break_start_time, break_end_time, timezone, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSchedule.run(
    'sched-default',
    '24/7 Full-Day WFH Schedule',
    '00:00',
    '23:59',
    '0,1,2,3,4,5,6',
    '00:00',
    '00:00',
    'UTC',
    1
  );

  // 6. Alert Rules
  const alertRules = [
    {
      id: 'ar-youtube',
      name: 'YouTube Working-Hours Limit Exceeded',
      rule_type: 'youtube_excessive',
      threshold_value: 1800, // 30 minutes in seconds
      window_minutes: 60,
      severity: 'high'
    },
    {
      id: 'ar-nonwork',
      name: 'Excessive Non-Work Activity Ratio',
      rule_type: 'non_work_percentage',
      threshold_value: 20, // 20% of active working hours
      window_minutes: 120,
      severity: 'medium'
    },
    {
      id: 'ar-blocked',
      name: 'Restricted / Blocked Domain Attempt',
      rule_type: 'blocked_domain',
      threshold_value: 1,
      window_minutes: 1,
      severity: 'critical'
    },
    {
      id: 'ar-offline',
      name: 'Device Offline Extended Period',
      rule_type: 'device_offline',
      threshold_value: 48, // 48 hours
      window_minutes: 1440,
      severity: 'low'
    }
  ];

  const alertRulesSeeded = db.prepare("SELECT value FROM system_settings WHERE key = 'alert_rules_initialized'").get();
  if (!alertRulesSeeded) {
    const insertAlertRule = db.prepare(`
      INSERT OR IGNORE INTO alert_rules (id, name, rule_type, threshold_value, window_minutes, severity, is_enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);

    for (const ar of alertRules) {
      insertAlertRule.run(ar.id, ar.name, ar.rule_type, ar.threshold_value, ar.window_minutes, ar.severity);
    }

    db.prepare(`
      INSERT INTO system_settings (key, value, description, updated_at)
      VALUES ('alert_rules_initialized', 'true', 'Default compliance alert rules initialized', ?)
    `).run(nowIso);
  }

  // 7. System Default Unassigned Pool & Initial Employees
  const insertEmp = db.prepare(`
    INSERT INTO employees (id, emp_code, name, email, department, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
    ON CONFLICT (id) DO UPDATE SET
      emp_code = excluded.emp_code,
      name = excluded.name,
      email = excluded.email,
      department = excluded.department
  `);
  insertEmp.run(
    'emp-unassigned',
    'EMP-UNASSIGNED',
    'Unassigned Hardware Pool',
    'unassigned@devices.internal',
    'IT Staging',
    nowIso
  );

  const initialEmployees: Array<{ id: string; emp_code: string; name: string; email: string; department: string }> = [];

  for (const emp of initialEmployees) {
    insertEmp.run(emp.id, emp.emp_code, emp.name, emp.email, emp.department, nowIso);
  }

  // 8. Restricted Applications (App Blocker) - Seeded once only, never overrides user changes
  const appsSeeded = db.prepare("SELECT value FROM system_settings WHERE key = 'blocked_apps_initialized'").get();
  if (!appsSeeded) {
    const defaultBlockedApps = [
      { id: 'app-spotify', proc: 'spotify.exe', name: 'Spotify Music', cat: 'cat-ent' },
      { id: 'app-steam', proc: 'steam.exe', name: 'Steam Gaming', cat: 'cat-ent' },
      { id: 'app-discord', proc: 'discord.exe', name: 'Discord', cat: 'cat-comm' },
      { id: 'app-epic', proc: 'epicgameslauncher.exe', name: 'Epic Games Launcher', cat: 'cat-ent' },
      { id: 'app-utorrent', proc: 'utorrent.exe', name: 'uTorrent', cat: 'cat-ent' },
      { id: 'app-telegram', proc: 'telegram.exe', name: 'Telegram Desktop', cat: 'cat-comm' }
    ];

    const insertApp = db.prepare(`
      INSERT OR IGNORE INTO applications (id, process_name, display_name, category_id, is_blocked)
      VALUES (?, ?, ?, ?, 1)
    `);

    for (const a of defaultBlockedApps) {
      insertApp.run(a.id, a.proc, a.name, a.cat);
    }

    db.prepare(`
      INSERT INTO system_settings (key, value, description, updated_at)
      VALUES ('blocked_apps_initialized', 'true', 'Default blocked applications initialized', ?)
    `).run(nowIso);
  }

  // 9. Restricted Websites / Domains (Auto-Close Tab) - Seeded once only, never overrides user changes
  const domainsSeeded = db.prepare("SELECT value FROM system_settings WHERE key = 'blocked_domains_initialized'").get();
  if (!domainsSeeded) {
    const defaultBlockedDomains = [
      { id: 'dom-youtube', domain: 'youtube.com', cat: 'cat-youtube' },
      { id: 'dom-chatgpt', domain: 'chatgpt.com', cat: 'cat-youtube' },
      { id: 'dom-netflix', domain: 'netflix.com', cat: 'cat-ent' },
      { id: 'dom-tiktok', domain: 'tiktok.com', cat: 'cat-social' },
      { id: 'dom-instagram', domain: 'instagram.com', cat: 'cat-social' },
      { id: 'dom-facebook', domain: 'facebook.com', cat: 'cat-social' }
    ];

    const insertDomain = db.prepare(`
      INSERT OR IGNORE INTO domains (id, domain, category_id, is_blocked)
      VALUES (?, ?, ?, 1)
    `);

    for (const d of defaultBlockedDomains) {
      insertDomain.run(d.id, d.domain, d.cat);
    }

    db.prepare(`
      INSERT INTO system_settings (key, value, description, updated_at)
      VALUES ('blocked_domains_initialized', 'true', 'Default blocked domains initialized', ?)
    `).run(nowIso);
  }

  // 10. Settings
  const settings = [
    { key: 'data_retention_days', value: '90', desc: 'Number of days activity logs are retained' },
    { key: 'privacy_policy_version', value: '2026.1', desc: 'Current revision of monitoring privacy policy' },
    {
      key: 'monitoring_notice_text',
      value: 'Activity monitoring is active on this company-owned device. Only application names and website domains are logged during working hours for productivity analysis. Passwords, keystrokes, personal messages, and screen contents are strictly never captured.',
      desc: 'Transparency banner displayed to employees on desktop agent start'
    },
    { key: 'idle_timeout_seconds', value: '180', desc: 'Inactivity threshold in seconds before marking user idle' },
    { key: 'batch_sync_interval_seconds', value: '30', desc: 'Frequency of desktop agent event synchronization' }
  ];

  const insertSetting = db.prepare(`
    INSERT INTO system_settings (key, value, description, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET
      value = excluded.value,
      description = excluded.description,
      updated_at = excluded.updated_at
  `);

  for (const s of settings) {
    insertSetting.run(s.key, s.value, s.desc, nowIso);
  }

  console.log('Database initialized with clean enterprise configuration (zero dummy data).');
}

export function clearDatabase() {
  initDatabase();
  console.log('[DB] Clearing all operational tables for fresh start...');
  db.exec(`
    DELETE FROM activity_events;
    DELETE FROM daily_summaries;
    DELETE FROM alerts;
    DELETE FROM audit_logs;
    DELETE FROM device_assignments;
    DELETE FROM devices;
  `);
  console.log('[DB] Operational tables cleared. Reseeding base configuration...');
  seedDatabase();
  console.log('[DB] Database is freshly re-initialized!');
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  if (process.argv.includes('--clear')) {
    clearDatabase();
  } else {
    seedDatabase();
  }
}
