import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/database.js';
import { authenticateAdmin, AuthenticatedAdminRequest } from '../middleware/auth.js';
import { logAuditAction } from '../middleware/audit.js';
import { refreshCategoryCache } from '../services/categorizer.js';

export const settingRouter = Router();
settingRouter.use(authenticateAdmin);

// 1. Work Schedules
settingRouter.get('/schedules', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const schedules = db.prepare('SELECT * FROM work_schedules').all();
  return res.json({ schedules });
});

settingRouter.put('/schedules/:id', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const scheduleId = String(req.params.id);
  const { name, workStartTime, workEndTime, workDays, breakStartTime, breakEndTime, timezone } = req.body;

  db.prepare(`
    UPDATE work_schedules 
    SET name = COALESCE(?, name),
        work_start_time = COALESCE(?, work_start_time),
        work_end_time = COALESCE(?, work_end_time),
        work_days = COALESCE(?, work_days),
        break_start_time = COALESCE(?, break_start_time),
        break_end_time = COALESCE(?, break_end_time),
        timezone = COALESCE(?, timezone)
    WHERE id = ?
  `).run(
    name ?? null,
    workStartTime ?? null,
    workEndTime ?? null,
    workDays ?? null,
    breakStartTime ?? null,
    breakEndTime ?? null,
    timezone ?? null,
    scheduleId
  );

  logAuditAction(req, 'UPDATE_SCHEDULE', 'work_schedules', scheduleId, req.body);
  return res.json({ success: true, message: 'Work schedule updated' });
});

// 2. Categories & Rules
settingRouter.get('/categories', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const categories = db.prepare(`
    SELECT c.*, COUNT(r.id) as rule_count
    FROM categories c
    LEFT JOIN category_rules r ON r.category_id = c.id
    GROUP BY c.id, c.name, c.color, c.is_work, c.description
  `).all();

  const rules = db.prepare(`
    SELECT r.*, c.name as category_name, c.color as category_color
    FROM category_rules r
    JOIN categories c ON r.category_id = c.id
    ORDER BY r.priority DESC, r.pattern ASC
  `).all();

  return res.json({ categories, rules });
});

settingRouter.post('/category-rules', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const { categoryId, matchType, pattern, priority } = req.body;

  if (!categoryId || !matchType || !pattern) {
    return res.status(400).json({ error: 'categoryId, matchType, and pattern are required' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO category_rules (id, category_id, match_type, pattern, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, categoryId, matchType, pattern.toLowerCase().trim(), priority || 10);

  refreshCategoryCache();
  logAuditAction(req, 'CREATE_CATEGORY_RULE', 'category_rules', id, req.body);

  return res.status(201).json({ id, categoryId, matchType, pattern });
});

settingRouter.delete('/category-rules/:id', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const id = String(req.params.id);
  db.prepare('DELETE FROM category_rules WHERE id = ?').run(id);

  refreshCategoryCache();
  logAuditAction(req, 'DELETE_CATEGORY_RULE', 'category_rules', id);

  return res.json({ success: true });
});

// 3. Blocked Domains
settingRouter.get('/blocked-domains', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const domains = db.prepare('SELECT * FROM domains WHERE is_blocked = 1').all();
  return res.json({ domains });
});

settingRouter.post('/blocked-domains', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const { domain, categoryId } = req.body;
  if (!domain) {
    return res.status(400).json({ error: 'domain is required' });
  }

  let clean = domain.toLowerCase().trim();
  // Strip protocol, www, and any URL path or query params
  clean = clean.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '');
  clean = clean.split('/')[0].split('?')[0].split('#')[0].trim();
  if (!clean.includes('.') && clean.length > 0) {
    clean = `${clean}.com`;
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO domains (id, domain, category_id, is_blocked)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(domain) DO UPDATE SET is_blocked = 1
  `).run(id, clean, categoryId || 'cat-youtube');

  logAuditAction(req, 'BLOCK_DOMAIN', 'domains', id, { domain: clean });
  return res.json({ success: true, domain: clean });
});

settingRouter.delete('/blocked-domains/:domain', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  let domain = String(req.params.domain).toLowerCase().trim();
  domain = domain.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split('/')[0].trim();
  db.prepare('DELETE FROM domains WHERE domain = ?').run(domain);

  logAuditAction(req, 'UNBLOCK_DOMAIN', 'domains', null, { domain });
  return res.json({ success: true });
});

// 3b. Blocked Applications / Process Restrictions
settingRouter.get('/blocked-apps', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const apps = db.prepare(`
    SELECT a.*, c.name as category_name
    FROM applications a
    LEFT JOIN categories c ON a.category_id = c.id
    WHERE a.is_blocked = 1
  `).all();
  return res.json({ apps });
});

settingRouter.post('/blocked-apps', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const { processName, displayName, categoryId } = req.body;
  if (!processName) {
    return res.status(400).json({ error: 'processName is required (e.g. spotify.exe)' });
  }

  let cleanProc = String(processName).toLowerCase().trim();
  cleanProc = cleanProc.replace(/\.com$/, ''); // Strip accidental .com from process names (e.g. spotify.com -> spotify)
  
  const norm = cleanProc.replace(/[^a-z0-9]/g, '');
  let resolvedDisplayName = displayName;

  if (norm.includes('vscode') || norm.includes('vscod') || norm.includes('vscoed') || norm === 'code' || norm === 'vs' || norm.includes('visualstudiocode') || norm.includes('visualstudio')) {
    cleanProc = 'code.exe';
    resolvedDisplayName = resolvedDisplayName || 'Visual Studio Code';
  } else if (norm === 'spotify') {
    cleanProc = 'spotify.exe';
    resolvedDisplayName = resolvedDisplayName || 'Spotify Music';
  } else if (norm === 'discord') {
    cleanProc = 'discord.exe';
    resolvedDisplayName = resolvedDisplayName || 'Discord';
  } else if (norm === 'steam') {
    cleanProc = 'steam.exe';
    resolvedDisplayName = resolvedDisplayName || 'Steam Gaming';
  } else if (norm.includes('chrome')) {
    cleanProc = 'chrome.exe';
    resolvedDisplayName = resolvedDisplayName || 'Google Chrome';
  } else if (norm === 'edge' || norm === 'msedge') {
    cleanProc = 'msedge.exe';
    resolvedDisplayName = resolvedDisplayName || 'Microsoft Edge';
  } else if (norm === 'notepad') {
    cleanProc = 'notepad.exe';
    resolvedDisplayName = resolvedDisplayName || 'Notepad';
  } else if (norm === 'calc' || norm === 'calculator') {
    cleanProc = 'calculatorapp.exe';
    resolvedDisplayName = resolvedDisplayName || 'Windows Calculator';
  } else if (norm.includes('telegram')) {
    cleanProc = 'telegram.exe';
    resolvedDisplayName = resolvedDisplayName || 'Telegram Desktop';
  } else if (norm.includes('whatsapp')) {
    cleanProc = 'whatsapp.exe';
    resolvedDisplayName = resolvedDisplayName || 'WhatsApp';
  } else if (norm.includes('torrent')) {
    cleanProc = 'utorrent.exe';
    resolvedDisplayName = resolvedDisplayName || 'uTorrent';
  } else if (norm === 'terminal' || norm === 'windowsterminal') {
    cleanProc = 'windowsterminal.exe';
    resolvedDisplayName = resolvedDisplayName || 'Windows Terminal';
  } else if (norm === 'word' || norm === 'msword' || norm === 'winword') {
    cleanProc = 'winword.exe';
    resolvedDisplayName = resolvedDisplayName || 'Microsoft Word';
  } else if (norm === 'excel' || norm === 'msexcel') {
    cleanProc = 'excel.exe';
    resolvedDisplayName = resolvedDisplayName || 'Microsoft Excel';
  } else if (norm === 'powerpoint' || norm === 'powerpnt' || norm === 'ppt') {
    cleanProc = 'powerpnt.exe';
    resolvedDisplayName = resolvedDisplayName || 'Microsoft PowerPoint';
  } else if (!cleanProc.endsWith('.exe')) {
    cleanProc += '.exe';
  }

  const name = resolvedDisplayName || cleanProc.replace('.exe', '');
  const id = uuidv4();

  db.prepare(`
    INSERT INTO applications (id, process_name, display_name, category_id, is_blocked)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(process_name) DO UPDATE SET is_blocked = 1, display_name = excluded.display_name
  `).run(id, cleanProc, name, categoryId || 'cat-ent');

  logAuditAction(req, 'BLOCK_APPLICATION', 'applications', id, { processName: cleanProc, displayName: name });
  return res.json({ success: true, processName: cleanProc, displayName: name });
});

settingRouter.delete('/blocked-apps/:processName', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  let cleanProc = String(req.params.processName).toLowerCase().trim();
  if (!cleanProc.endsWith('.exe')) {
    cleanProc += '.exe';
  }

  db.prepare('DELETE FROM applications WHERE process_name = ?').run(cleanProc);

  logAuditAction(req, 'UNBLOCK_APPLICATION', 'applications', null, { processName: cleanProc });
  return res.json({ success: true });
});

// 4. Audit Logs
settingRouter.get('/audit-logs', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const logs = db.prepare(`
    SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?
  `).all(limit) as Array<any>;

  const formatted = logs.map((l) => {
    let details = {};
    try {
      details = JSON.parse(l.details_json || '{}');
    } catch {
      details = {};
    }
    return {
      id: l.id,
      adminId: l.admin_id,
      adminEmail: l.admin_email || 'admin@company.com',
      action: l.action || 'ACTION',
      targetEntity: l.target_entity || 'system',
      targetId: l.target_id,
      ipAddress: l.ip_address || '127.0.0.1',
      details,
      createdAt: l.created_at
    };
  });

  return res.json({ logs: formatted });
});

settingRouter.delete('/audit-logs', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  db.prepare('DELETE FROM audit_logs').run();
  return res.json({ success: true, message: 'Administrator audit trail cleared successfully' });
});

settingRouter.post('/audit-logs/clear', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  db.prepare('DELETE FROM audit_logs').run();
  return res.json({ success: true, message: 'Administrator audit trail cleared successfully' });
});

// 5. System Retention & Privacy Policy Settings
settingRouter.get('/system-settings', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const settings = db.prepare('SELECT * FROM system_settings').all();
  return res.json({ settings });
});

settingRouter.post('/system-settings', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const { key, value } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value are required' });
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?
  `).run(String(value), now, key);

  logAuditAction(req, 'UPDATE_SETTING', 'system_settings', key, { value });
  return res.json({ success: true, key, value });
});
