import { Router, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/database.js';
import { authenticateAdmin, AuthenticatedAdminRequest } from '../middleware/auth.js';
import { logAuditAction } from '../middleware/audit.js';
import { updateDailySummary } from '../services/aggregator.js';
import { refreshRevokedCache } from './agentRoutes.js';

export const deviceRouter = Router();

// Direct download for laptop deployment
deviceRouter.get('/download-installer', (req, res): Response | void => {
  const candidates = [
    path.resolve(process.cwd(), 'KellaMonitor-Employee-Setup.zip'),
    path.resolve(process.cwd(), '../KellaMonitor-Employee-Setup.zip'),
    path.resolve(process.cwd(), '../../KellaMonitor-Employee-Setup.zip'),
    path.resolve(process.cwd(), 'desk/KellaMonitor-Employee-Setup.zip'),
    'C:\\work\\Sankar\\desk\\KellaMonitor-Employee-Setup.zip',
    'C:\\work\\Sankar\\KellaMonitor-Employee-Setup.zip'
  ];
  const target = candidates.find((p) => fs.existsSync(p));
  if (!target) {
    return res.status(404).json({ error: 'Installer package not found' });
  }
  return res.download(target, 'KellaMonitor-Employee-Setup.zip');
});

deviceRouter.use(authenticateAdmin);

deviceRouter.get('/', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const now = Date.now();
  const onlineCutoff = new Date(now - 90 * 1000).toISOString(); // 90 seconds (online margin)
  const stoppedCutoff = new Date(now - 5 * 60 * 1000).toISOString(); // 5 minutes before considering agent stopped
  const recentCutoff = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 48 hours

  const devices = db.prepare(`
    SELECT 
      d.id, d.device_identifier, d.hostname, d.os_version, d.serial_number,
      d.registered_at, d.last_seen_at, d.status,
      e.id as employee_id, e.emp_code, e.name as employee_name, e.department,
      ls.app_name as live_app_name, ls.process_name as live_process_name,
      ls.window_title as live_window_title, ls.domain as live_domain,
      ls.start_time as live_start_time, ls.duration_seconds as live_duration_seconds,
      ls.is_idle as live_is_idle, ls.updated_at as live_updated_at
    FROM devices d
    LEFT JOIN device_assignments da ON da.device_id = d.id AND da.is_active = 1
    LEFT JOIN employees e ON e.id = da.employee_id
    LEFT JOIN device_live_status ls ON ls.device_id = d.id
    ORDER BY 
      CASE 
        -- Priority -1: Uninstalled or Tampered devices (CRITICAL - TOP OF LIST)
        WHEN d.status = 'uninstalled' THEN -1
        -- Priority 0: Recently active agent that has STOPPED communicating for > 5 min
        WHEN d.status = 'active' AND d.last_seen_at < ? AND d.last_seen_at >= ? THEN 0
        -- Priority 1: Currently online & healthy
        WHEN d.status = 'active' AND d.last_seen_at >= ? THEN 1
        -- Priority 2: Inactive, never seen, or revoked
        ELSE 2
      END ASC,
      d.last_seen_at DESC,
      d.registered_at DESC
  `).all(stoppedCutoff, recentCutoff, onlineCutoff) as Array<any>;

  const formatElapsed = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s ago`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  const formatted = devices.map((d) => {
    const lastSeenMs = d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0;
    const isUninstalled = d.status === 'uninstalled';
    const isOnline = d.status === 'active' && d.last_seen_at >= onlineCutoff;
    const isStopped = d.status === 'active' && d.last_seen_at < stoppedCutoff && d.last_seen_at >= recentCutoff;
    const stoppedSinceSeconds = (isStopped || isUninstalled) ? Math.max(0, Math.floor((now - lastSeenMs) / 1000)) : 0;

    let statusLabel: 'uninstalled' | 'online' | 'stopped' | 'offline' | 'revoked' = 'offline';
    if (d.status === 'uninstalled') {
      statusLabel = 'uninstalled';
    } else if (d.status === 'revoked') {
      statusLabel = 'revoked';
    } else if (isStopped) {
      statusLabel = 'stopped';
    } else if (isOnline) {
      statusLabel = 'online';
    }

    const liveStartMs = d.live_start_time ? new Date(d.live_start_time).getTime() : 0;
    const liveDurationSeconds = isOnline && liveStartMs > 0 ? Math.max(1, Math.round((now - liveStartMs) / 1000)) : (d.live_duration_seconds || 0);

    return {
      id: d.id,
      identifier: d.device_identifier,
      hostname: d.hostname,
      osVersion: d.os_version,
      serialNumber: d.serial_number,
      registeredAt: d.registered_at,
      lastSeenAt: d.last_seen_at,
      status: d.status,
      isOnline,
      isStopped,
      isUninstalled,
      stoppedSinceSeconds,
      stoppedDurationText: (isStopped || isUninstalled) ? formatElapsed(stoppedSinceSeconds) : null,
      statusLabel,
      assignedEmployee: (d.employee_id && d.employee_id !== 'emp-unassigned')
        ? {
            id: d.employee_id,
            empCode: d.emp_code,
            name: d.employee_name,
            department: d.department
          }
        : null,
      liveStatus: isOnline && d.live_app_name ? {
        appName: d.live_app_name,
        processName: d.live_process_name,
        windowTitle: d.live_window_title,
        domain: d.live_domain,
        startTime: d.live_start_time,
        liveDurationSeconds,
        isIdle: d.live_is_idle === 1
      } : null
    };
  });

  return res.json({ devices: formatted });
});

deviceRouter.get('/:id/activity', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const deviceId = String(req.params.id);
  const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);

  const device = db.prepare(`
    SELECT 
      d.id, d.device_identifier, d.hostname, d.os_version, d.serial_number,
      d.registered_at, d.last_seen_at, d.status,
      e.id as employee_id, e.emp_code, e.name as employee_name, e.department
    FROM devices d
    LEFT JOIN device_assignments da ON da.device_id = d.id AND da.is_active = 1
    LEFT JOIN employees e ON e.id = da.employee_id
    WHERE d.id = ?
  `).get(deviceId) as any;

  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const onlineCutoff = new Date(Date.now() - 90 * 1000).toISOString();
  const isOnline = device.last_seen_at >= onlineCutoff;

  // Daily summary for this device
  const summary = db.prepare(`
    SELECT * FROM daily_summaries WHERE device_id = ? AND date = ?
  `).get(deviceId, date) as any;

  // Recent activity stream for this device
  const events = db.prepare(`
    SELECT 
      e.id, e.start_time, e.end_time, e.duration_seconds,
      e.app_name, e.process_name, e.window_title_sanitized, e.domain, e.is_idle,
      c.id as category_id, c.name as category_name, c.color as category_color, c.is_work
    FROM activity_events e
    JOIN categories c ON e.category_id = c.id
    WHERE e.device_id = ? AND substr(e.start_time, 1, 10) = ?
    ORDER BY e.start_time ASC
  `).all(deviceId, date) as any[];

  // Consolidate continuous sessions
  const consolidated: any[] = [];
  for (const r of events) {
    const prev = consolidated.length > 0 ? consolidated[consolidated.length - 1] : null;
    const isSameSession =
      prev &&
      (prev.process_name || '').toLowerCase() === (r.process_name || '').toLowerCase() &&
      (prev.domain || '').toLowerCase() === (r.domain || '').toLowerCase() &&
      prev.is_work === r.is_work;

    if (isSameSession && prev) {
      prev.end_time = r.end_time;
      prev.duration_seconds += r.duration_seconds;
      if (r.window_title_sanitized) prev.window_title_sanitized = r.window_title_sanitized;
    } else {
      consolidated.push({ ...r });
    }
  }

  return res.json({
    device: {
      id: device.id,
      identifier: device.device_identifier,
      hostname: device.hostname,
      osVersion: device.os_version,
      isOnline,
      lastSeenAt: device.last_seen_at,
      assignedEmployee: (device.employee_id && device.employee_id !== 'emp-unassigned') ? {
        id: device.employee_id,
        empCode: device.emp_code,
        name: device.employee_name,
        department: device.department
      } : null
    },
    summary: summary || {
      active_time_seconds: consolidated.filter(a => a.is_work === 1 && a.is_idle === 0).reduce((acc, a) => acc + a.duration_seconds, 0),
      idle_time_seconds: consolidated.filter(a => a.is_idle === 1).reduce((acc, a) => acc + a.duration_seconds, 0),
      total_time_seconds: consolidated.reduce((acc, a) => acc + a.duration_seconds, 0),
      youtube_seconds: consolidated.filter(a => a.category_id === 'cat-youtube' || (a.domain && a.domain.includes('youtube'))).reduce((acc, a) => acc + a.duration_seconds, 0),
      top_apps_json: summary?.top_apps_json || '[]',
      top_domains_json: summary?.top_domains_json || '[]'
    },
    activities: consolidated.reverse()
  });
});

deviceRouter.post('/:id/revoke', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const deviceId = String(req.params.id);

  const dev = db.prepare('SELECT id, device_identifier, hostname FROM devices WHERE id = ?').get(deviceId) as { id: string; device_identifier: string; hostname: string } | undefined;
  if (dev) {
    db.prepare(`
      INSERT OR REPLACE INTO revoked_devices (id, device_identifier, hostname, reason, revoked_at)
      VALUES (?, ?, ?, 'Manually revoked by administrator', ?)
    `).run(uuidv4(), dev.device_identifier, dev.hostname, new Date().toISOString());
    refreshRevokedCache();
  }

  db.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").run(deviceId);
  db.prepare('DELETE FROM device_live_status WHERE device_id = ?').run(deviceId);
  logAuditAction(req, 'REVOKE_DEVICE', 'devices', deviceId);

  return res.json({ success: true, message: 'Device revoked successfully' });
});

deviceRouter.post('/:id/assign', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const deviceId = String(req.params.id);
  const { employeeId } = req.body;

  if (!employeeId) {
    return res.status(400).json({ error: 'employeeId is required' });
  }

  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
  if (!emp) {
    return res.status(404).json({ error: `Employee ${employeeId} not found` });
  }

  const dev = db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId);
  if (!dev) {
    return res.status(404).json({ error: `Device ${deviceId} not found` });
  }

  // Deactivate prior assignments for this device or employee
  db.prepare('UPDATE device_assignments SET is_active = 0, unassigned_at = ? WHERE employee_id = ? OR device_id = ?')
    .run(new Date().toISOString(), employeeId, deviceId);

  // Insert new active assignment
  const assignmentId = uuidv4();
  db.prepare(`
    INSERT INTO device_assignments (id, device_id, employee_id, assigned_at, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run(assignmentId, deviceId, employeeId, new Date().toISOString());

  // Retroactively link unassigned events to the newly assigned employee
  db.prepare(`
    UPDATE activity_events 
    SET employee_id = ? 
    WHERE device_id = ? AND (employee_id = 'emp-unassigned' OR employee_id IS NULL OR employee_id = '')
  `).run(employeeId, deviceId);

  // Re-aggregate employee's daily productivity summary
  const today = new Date().toISOString().substring(0, 10);
  try {
    updateDailySummary(employeeId, deviceId, today);
    db.prepare("DELETE FROM daily_summaries WHERE device_id = ? AND employee_id = 'emp-unassigned'").run(deviceId);
  } catch (err) {
    console.warn('[AssignDevice] Could not refresh daily summary:', err);
  }

  logAuditAction(req, 'ASSIGN_DEVICE', 'device_assignments', assignmentId, { employeeId, deviceId });

  return res.json({ success: true, assignmentId, employeeId, deviceId });
});

deviceRouter.post('/stop-all', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const allDevs = db.prepare('SELECT id, device_identifier, hostname FROM devices').all() as any[];
  const now = new Date().toISOString();
  for (const d of allDevs) {
    db.prepare(`
      INSERT OR REPLACE INTO revoked_devices (id, device_identifier, hostname, reason, revoked_at)
      VALUES (?, ?, ?, 'Stop-All triggered by admin', ?)
    `).run(uuidv4(), d.device_identifier, d.hostname, now);
  }
  refreshRevokedCache();

  db.prepare("UPDATE devices SET status = 'revoked'").run();
  db.prepare('DELETE FROM device_live_status').run();
  logAuditAction(req, 'REVOKE_ALL_DEVICES', 'devices', 'all');
  return res.json({ success: true, message: 'All devices stopped and revoked successfully' });
});

deviceRouter.post('/clear-all', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  db.prepare('DELETE FROM device_assignments').run();
  db.prepare('DELETE FROM device_live_status').run();
  db.prepare('DELETE FROM activity_events').run();
  db.prepare('DELETE FROM daily_summaries').run();
  db.prepare('DELETE FROM alerts').run();
  db.prepare('DELETE FROM devices').run();

  logAuditAction(req, 'CLEAR_ALL_DEVICES', 'devices', 'all');
  return res.json({ success: true, message: 'All devices and associated logs wiped completely' });
});

deviceRouter.delete('/clear-all', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  db.prepare('DELETE FROM device_assignments').run();
  db.prepare('DELETE FROM device_live_status').run();
  db.prepare('DELETE FROM activity_events').run();
  db.prepare('DELETE FROM daily_summaries').run();
  db.prepare('DELETE FROM alerts').run();
  db.prepare('DELETE FROM devices').run();

  logAuditAction(req, 'CLEAR_ALL_DEVICES', 'devices', 'all');
  return res.json({ success: true, message: 'All devices and associated logs wiped completely' });
});

deviceRouter.post('/:id/unassign', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const deviceId = String(req.params.id);

  db.prepare('DELETE FROM device_assignments WHERE device_id = ?').run(deviceId);
  logAuditAction(req, 'UNASSIGN_DEVICE', 'devices', deviceId);

  return res.json({ success: true, message: 'Device unassigned from employee successfully' });
});

deviceRouter.delete('/:id', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const deviceId = String(req.params.id);

  db.prepare('DELETE FROM device_assignments WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM device_live_status WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM activity_events WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM daily_summaries WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM alerts WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);

  logAuditAction(req, 'DELETE_DEVICE', 'devices', deviceId);

  return res.json({ success: true, message: 'Device deleted permanently' });
});
