import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/database.js';
import { authenticateDevice, AuthenticatedDeviceRequest } from '../middleware/auth.js';
import { categorizeEvent, checkWorkingHours } from '../services/categorizer.js';
import { evaluateAlertsForEmployee, checkBlockedDomainAccess, resolveDeviceDisconnectionAlerts } from '../services/alertEngine.js';
import { updateDailySummary } from '../services/aggregator.js';

export const agentRouter = Router();

export const revokedCache = new Set<string>();

export function refreshRevokedCache() {
  try {
    const rows = db.prepare('SELECT device_identifier, hostname FROM revoked_devices').all() as any[];
    for (const r of rows) {
      if (r.device_identifier) revokedCache.add(r.device_identifier);
      if (r.hostname) revokedCache.add(r.hostname);
    }
  } catch {}
}

// Initialize cache on startup
refreshRevokedCache();

// 0. Validate Device Identifier Uniqueness before installation
agentRouter.get('/validate-identifier', (req: Request, res: Response): Response | void => {
  const identifier = String(req.query.id || req.query.identifier || '').trim();
  const hostname = String(req.query.hostname || '').trim();

  if (!identifier) {
    return res.status(400).json({ available: false, error: 'Laptop ID is required' });
  }

  // Look for any existing device with this identifier
  const existing = db.prepare(`
    SELECT d.id, d.device_identifier, d.hostname, d.status, e.name as employee_name
    FROM devices d
    LEFT JOIN device_assignments da ON da.device_id = d.id AND da.is_active = 1
    LEFT JOIN employees e ON e.id = da.employee_id
    WHERE LOWER(d.device_identifier) = LOWER(?)
    LIMIT 1
  `).get(identifier) as any;

  if (!existing) {
    return res.json({ available: true, message: `Laptop ID '${identifier}' is available` });
  }

  // If found, check if it's the SAME laptop reinstalling (same hostname)
  if (hostname && existing.hostname && existing.hostname.toLowerCase() === hostname.toLowerCase()) {
    return res.json({
      available: true,
      isReinstall: true,
      message: `Laptop ID '${identifier}' belongs to this laptop (${hostname}). Re-enrollment allowed.`
    });
  }

  // Otherwise, it is a DUPLICATE assigned to another device!
  return res.json({
    available: false,
    error: `Laptop ID '${identifier}' is ALREADY in use by another laptop!`,
    existingHostname: existing.hostname,
    existingEmployee: existing.employee_name || 'Unassigned',
    existingStatus: existing.status
  });
});

// 1. Device Registration Handshake
agentRouter.post('/register', (req: Request, res: Response): Response | void => {
  const { hostname, osVersion, serialNumber, macAddress, enrollmentSecret } = req.body;
  let { deviceIdentifier } = req.body;

  if (!hostname) {
    return res.status(400).json({ error: 'hostname is required' });
  }

  if (!deviceIdentifier) {
    const hash = crypto.createHash('sha256').update(String(hostname).toLowerCase()).digest('hex').substring(0, 8).toUpperCase();
    deviceIdentifier = `CORP-LT-${hash}`;
    console.log(`[Agent Register] Auto-generated deviceIdentifier ${deviceIdentifier} for host ${hostname}`);
  }

  // If device or hostname was previously revoked, un-revoke it so old/re-used laptops can re-enroll freely!
  if (revokedCache.has(deviceIdentifier) || (hostname && revokedCache.has(hostname))) {
    console.log(`[Agent Register] Re-enrolling previously removed/revoked device ${deviceIdentifier} (${hostname}). Un-revoking device.`);
    revokedCache.delete(deviceIdentifier);
    if (hostname) revokedCache.delete(hostname);
    try {
      db.prepare(`DELETE FROM revoked_devices WHERE device_identifier = ? OR hostname = ?`).run(deviceIdentifier, hostname);
    } catch {}
  }

  // Generate a cryptographically secure token for this device
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = bcrypt.hashSync(rawToken, 10);
  const now = new Date().toISOString();

  // Check if this physical laptop (hostname) was previously registered
  const existing = db.prepare(`
    SELECT id, status, secret_hash, device_identifier, hostname FROM devices 
    WHERE LOWER(hostname) = LOWER(?)
    LIMIT 1
  `).get(hostname) as { id: string; status: string; device_identifier: string; hostname: string } | undefined;

  // Check if deviceIdentifier is already claimed by a DIFFERENT physical laptop
  const idCollision = db.prepare(`
    SELECT id, hostname FROM devices 
    WHERE LOWER(device_identifier) = LOWER(?) AND LOWER(hostname) != LOWER(?)
    LIMIT 1
  `).get(deviceIdentifier, hostname) as { id: string; hostname: string } | undefined;

  if (idCollision) {
    const shortHost = String(hostname).replace(/[^a-zA-Z0-9]/g, '').substring(0, 6);
    deviceIdentifier = `${deviceIdentifier}-${shortHost}`;
    console.warn(`[Agent Register] Device identifier collision with host ${idCollision.hostname}. Auto-disambiguated to: ${deviceIdentifier}`);
  }

  let deviceId: string;

  if (existing) {
    deviceId = existing.id;
    db.prepare(`
      UPDATE devices 
      SET device_identifier = ?, hostname = ?, os_version = ?, last_seen_at = ?, secret_hash = ?, status = 'active'
      WHERE id = ?
    `).run(deviceIdentifier, hostname, osVersion || 'Windows', now, tokenHash, deviceId);

    // Auto-resolve open disconnection alert since device is now active
    db.prepare(`
      UPDATE alerts 
      SET status = 'resolved', resolved_at = ? 
      WHERE device_id = ? AND status = 'open' AND title LIKE '%Agent Stopped%'
    `).run(now, deviceId);
  } else {
    deviceId = uuidv4();
    db.prepare(`
      INSERT INTO devices (
        id, device_identifier, hostname, os_version, serial_number, mac_address,
        registered_at, last_seen_at, status, secret_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      deviceId,
      deviceIdentifier,
      hostname,
      osVersion || 'Windows',
      serialNumber || null,
      macAddress || null,
      now,
      now,
      tokenHash
    );
  }

  // Check if this device already has an active assignment
  let assignment = db.prepare(`
    SELECT e.id as employee_id, e.emp_code, e.name, e.department
    FROM device_assignments da
    JOIN employees e ON da.employee_id = e.id
    WHERE da.device_id = ? AND da.is_active = 1
  `).get(deviceId) as { employee_id: string; emp_code: string; name: string; department: string } | undefined;

  // Only link to an existing employee if requestedEmpName matches an existing record; NEVER create fake employees!
  const requestedEmpName = typeof req.body.employeeName === 'string' ? req.body.employeeName.trim() : '';
  if (requestedEmpName) {
    let emp = db.prepare("SELECT id, emp_code, name, department FROM employees WHERE LOWER(name) = LOWER(?) AND id != 'emp-unassigned' LIMIT 1").get(requestedEmpName) as { id: string; emp_code: string; name: string; department: string } | undefined;
    if (emp) {
      if (!assignment || assignment.employee_id !== emp.id) {
        // Deactivate any prior active assignment for this device
        db.prepare(`
          UPDATE device_assignments 
          SET is_active = 0, unassigned_at = ? 
          WHERE device_id = ? AND is_active = 1
        `).run(now, deviceId);

        // Create new active assignment
        db.prepare(`
          INSERT INTO device_assignments (id, device_id, employee_id, assigned_at, is_active)
          VALUES (?, ?, ?, ?, 1)
        `).run(uuidv4(), deviceId, emp.id, now);

        assignment = {
          employee_id: emp.id,
          emp_code: emp.emp_code,
          name: emp.name,
          department: emp.department
        };
        console.log(`[Agent Register] Device ${deviceIdentifier} successfully assigned to existing employee ${emp.name} (${emp.emp_code})`);
      }
    } else {
      console.log(`[Agent Register] Device ${deviceIdentifier} registered in Company Devices pool without auto-creating employee.`);
    }
  }

  // Retrieve monitoring notification text
  const noticeSetting = db.prepare(`
    SELECT value FROM system_settings WHERE key = 'monitoring_notice_text'
  `).get() as { value: string } | undefined;

  const blockedApps = db.prepare(`
    SELECT process_name FROM applications WHERE is_blocked = 1
  `).all() as Array<{ process_name: string }>;

  const blockedDomains = db.prepare(`
    SELECT domain FROM domains WHERE is_blocked = 1
  `).all() as Array<{ domain: string }>;

  return res.json({
    success: true,
    deviceId,
    deviceIdentifier,
    deviceToken: rawToken,
    assignedEmployee: assignment || null,
    monitoringNotice: noticeSetting?.value || 'Activity monitoring is active on this company-owned device.',
    blockedApps: blockedApps.map(a => a.process_name),
    blockedDomains: blockedDomains.map(d => d.domain),
    settings: {
      syncIntervalSeconds: 30,
      idleTimeoutSeconds: 180
    }
  });
});

// Device Uninstallation & Tamper Alert Endpoint
agentRouter.post('/uninstall', (req: Request, res: Response): Response | void => {
  const { deviceIdentifier, hostname, reason } = req.body;

  let device: any = null;
  if (deviceIdentifier) {
    device = db.prepare(`SELECT * FROM devices WHERE device_identifier = ?`).get(deviceIdentifier);
  }
  if (!device && hostname) {
    device = db.prepare(`SELECT * FROM devices WHERE hostname = ? ORDER BY last_seen_at DESC LIMIT 1`).get(hostname);
  }

  const now = new Date().toISOString();

  if (device) {
    // 1. Mark device status as 'uninstalled'
    db.prepare(`UPDATE devices SET status = 'uninstalled', last_seen_at = ? WHERE id = ?`).run(now, device.id);

    // 2. Clear live active status
    db.prepare(`DELETE FROM device_live_status WHERE device_id = ?`).run(device.id);

    // 3. Look up assigned employee
    const assignment = db.prepare(`
      SELECT e.id, e.name, e.emp_code, e.department
      FROM device_assignments da
      JOIN employees e ON da.employee_id = e.id
      WHERE da.device_id = ? AND da.is_active = 1
    `).get(device.id) as any;

    const empName = assignment ? `${assignment.name} (${assignment.emp_code})` : 'Unassigned Pool';
    const hostText = device.hostname || hostname || 'Unknown Laptop';
    const idText = device.device_identifier || deviceIdentifier || device.id;

    // 4. Create high-visibility critical alert in alerts table
    const alertId = uuidv4();
    const title = `🚨 Agent Uninstalled: ${hostText} [${idText}]`;
    const message = `Monitoring agent was uninstalled or removed from Laptop [${hostText}] (Device ID: ${idText}) assigned to Employee: ${empName}. Monitoring has ceased.`;

    db.prepare(`
      INSERT INTO alerts (
        id, device_id, employee_id, triggered_at, severity, title, message, details_json, status
      ) VALUES (?, ?, ?, ?, 'critical', ?, ?, ?, 'open')
    `).run(
      alertId,
      device.id,
      assignment?.id || 'emp-unassigned',
      now,
      title,
      message,
      JSON.stringify({
        laptopId: idText,
        hostname: hostText,
        employeeName: assignment?.name || 'Unassigned Pool',
        empCode: assignment?.emp_code || 'N/A',
        department: assignment?.department || 'N/A',
        uninstalledAt: now,
        reason: reason || 'Agent Uninstaller Executed',
        isTamperAlert: true
      })
    );

    console.log(`[Alert Engine] 🚨 CRITICAL: Monitoring Agent uninstalled on ${hostText} (${empName})`);
    return res.json({ success: true, message: 'Uninstallation recorded and critical alert triggered', deviceId: device.id });
  }

  return res.json({ success: false, message: 'Device not found' });
});

function updateDeviceLiveStatus(deviceId: string, live: {
  appName?: string;
  processName?: string;
  windowTitle?: string;
  domain?: string | null;
  startTime?: string;
  durationSeconds?: number;
  isIdle?: boolean;
}) {
  if (!live || (!live.appName && !live.processName)) return;
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO device_live_status (
        device_id, app_name, process_name, window_title, domain, start_time, last_sample_time, duration_seconds, is_idle, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        app_name = excluded.app_name,
        process_name = excluded.process_name,
        window_title = excluded.window_title,
        domain = excluded.domain,
        start_time = excluded.start_time,
        last_sample_time = excluded.last_sample_time,
        duration_seconds = excluded.duration_seconds,
        is_idle = excluded.is_idle,
        updated_at = excluded.updated_at
    `).run(
      deviceId,
      live.appName || live.processName || 'Unknown App',
      live.processName || 'unknown.exe',
      live.windowTitle || '',
      live.domain || null,
      live.startTime || now,
      now,
      Math.max(1, Math.round(Number(live.durationSeconds) || 1)),
      live.isIdle ? 1 : 0,
      now
    );
  } catch (e) {
    console.error('[updateDeviceLiveStatus ERROR]:', e);
  }
}

// 2. Periodic Agent Heartbeat
agentRouter.post('/heartbeat', authenticateDevice, (req: AuthenticatedDeviceRequest, res: Response): Response | void => {
  const deviceId = req.device!.id;

  // If agent sent its current active foreground app / tab, persist live status immediately
  if (req.body && req.body.currentActiveApp) {
    updateDeviceLiveStatus(deviceId, req.body.currentActiveApp);
  }

  // Retrieve current active employee assignment
  const assignment = db.prepare(`
    SELECT e.id as employee_id, e.emp_code, e.name, e.department
    FROM device_assignments da
    JOIN employees e ON da.employee_id = e.id
    WHERE da.device_id = ? AND da.is_active = 1
  `).get(deviceId) as { employee_id: string; emp_code: string; name: string; department: string } | undefined;

  const policyVersion = db.prepare(`
    SELECT value FROM system_settings WHERE key = 'privacy_policy_version'
  `).get() as { value: string } | undefined;

  const notice = db.prepare(`
    SELECT value FROM system_settings WHERE key = 'monitoring_notice_text'
  `).get() as { value: string } | undefined;

  const blockedApps = db.prepare(`
    SELECT process_name, display_name FROM applications WHERE is_blocked = 1
  `).all() as Array<{ process_name: string; display_name: string }>;

  const blockedDomains = db.prepare(`
    SELECT domain FROM domains WHERE is_blocked = 1
  `).all() as Array<{ domain: string }>;

  // Reconnected: resolve any open disconnection alerts for this device
  resolveDeviceDisconnectionAlerts(deviceId);

  return res.json({
    status: 'ok',
    assignedEmployee: assignment || null,
    policyVersion: policyVersion?.value || '1.0',
    monitoringNotice: notice?.value || 'Activity monitoring is active on this company-owned device.',
    blockedApps: blockedApps.map(a => a.process_name),
    blockedDomains: blockedDomains.map(d => d.domain),
    serverTime: new Date().toISOString()
  });
});

// 3. Batch Event Ingestion (Privacy-Preserving & High Throughput)
agentRouter.post('/events/batch', authenticateDevice, (req: AuthenticatedDeviceRequest, res: Response): Response | void => {
  try {
    const { events } = req.body;
    const deviceId = req.device!.id;
    const assignedEmployeeId = req.device!.employee_id || 'emp-unassigned';

    console.log(`[Agent Events/Batch] Received ${events?.length} events from device ${deviceId} (${req.device?.device_identifier}) for employee ${assignedEmployeeId}`);

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'Payload must include non-empty events array' });
    }

    const nowIso = new Date().toISOString();
    const targetDatesToUpdate = new Set<string>();

  const insertStmt = db.prepare(`
    INSERT INTO activity_events (
      id, device_id, employee_id, event_type, process_name, app_name, domain,
      window_title_sanitized, start_time, end_time, duration_seconds, is_idle,
      is_working_hours, category_id, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      end_time = excluded.end_time,
      duration_seconds = excluded.duration_seconds,
      window_title_sanitized = excluded.window_title_sanitized,
      is_idle = excluded.is_idle,
      category_id = excluded.category_id,
      synced_at = excluded.synced_at
  `);

  let insertedCount = 0;

  db.exec('BEGIN TRANSACTION');
  try {
    for (const raw of events) {
      // Strict privacy sanitization:
      // 1. Never accept raw query parameters or paths; extract base host/domain only
      let cleanDomain: string | null = null;
      if (raw.domain) {
        try {
          let domainStr = raw.domain.trim().toLowerCase();
          if (domainStr.startsWith('http://') || domainStr.startsWith('https://')) {
            domainStr = new URL(domainStr).hostname;
          } else {
            // Remove path or query if present
            domainStr = domainStr.split('/')[0].split('?')[0].split(':')[0];
          }
          cleanDomain = domainStr.replace(/^[.*]/, '');
        } catch {
          cleanDomain = null;
        }
      }

      // 2. Sanitize window title to drop potential passwords or sensitive tokens
      let sanitizedTitle: string = (raw.windowTitle || raw.appName || '').trim();
      // Strip common sensitive patterns if accidentally in title
      sanitizedTitle = sanitizedTitle.replace(/token[=:][^ &]+/gi, 'token=REDACTED');
      sanitizedTitle = sanitizedTitle.replace(/key[=:][^ &]+/gi, 'key=REDACTED');
      sanitizedTitle = sanitizedTitle.replace(/password[=:][^ &]+/gi, 'password=REDACTED');
      sanitizedTitle = sanitizedTitle.replace(/secret[=:][^ &]+/gi, 'secret=REDACTED');
      if (sanitizedTitle.length > 255) {
        sanitizedTitle = sanitizedTitle.substring(0, 255);
      }

      const durationSeconds = Math.max(1, Math.round(Number(raw.durationSeconds) || 1));
      const isIdle = raw.isIdle ? 1 : 0;
      const processName = (raw.processName || 'unknown.exe').toLowerCase();
      const appName = raw.appName || processName.replace('.exe', '');
      const startTime = raw.startTime || nowIso;
      const endTime = raw.endTime || nowIso;

      // Check working hours
      const { isWorkingHours } = checkWorkingHours(startTime);

      // Dynamic Categorization
      const catResult = categorizeEvent(processName, cleanDomain, sanitizedTitle);

      const eventId = raw.id || uuidv4();
      const eventDate = startTime.substring(0, 10);
      targetDatesToUpdate.add(eventDate);

      insertStmt.run(
        eventId,
        deviceId,
        assignedEmployeeId,
        raw.eventType || (cleanDomain ? 'web' : isIdle ? 'idle' : 'app'),
        processName,
        appName,
        cleanDomain,
        sanitizedTitle,
        startTime,
        endTime,
        durationSeconds,
        isIdle,
        isWorkingHours ? 1 : 0,
        catResult.categoryId,
        nowIso
      );

      // Check for blocked domain access attempt
      if (cleanDomain) {
        checkBlockedDomainAccess(deviceId, assignedEmployeeId, cleanDomain, startTime);
      }

      insertedCount++;
    }
    db.exec('COMMIT');
  } catch (txErr) {
    db.exec('ROLLBACK');
    throw txErr;
  }

  // Update live status with the most recent genuine active event in the batch (ignoring closed/terminated events)
  if (events.length > 0) {
    const nonRestrictedEvents = events.filter((e: any) =>
      !(e.windowTitle || '').includes('[RESTRICTED WEBSITE TAB CLOSED]') &&
      !(e.windowTitle || '').includes('[BLOCKED APPLICATION TERMINATED]')
    );
    if (nonRestrictedEvents.length > 0) {
      const latestRaw = nonRestrictedEvents[nonRestrictedEvents.length - 1];
      updateDeviceLiveStatus(deviceId, {
        appName: latestRaw.appName,
        processName: latestRaw.processName,
        windowTitle: latestRaw.windowTitle,
        domain: latestRaw.domain,
        startTime: latestRaw.startTime,
        durationSeconds: latestRaw.durationSeconds,
        isIdle: Boolean(latestRaw.isIdle)
      });
    }
  }

  // Update daily summaries and evaluate alert rules asynchronously so API responds in < 3ms
  setImmediate(() => {
    try {
      for (const dt of targetDatesToUpdate) {
        updateDailySummary(assignedEmployeeId, deviceId, dt);
        if (assignedEmployeeId !== 'emp-unassigned') {
          evaluateAlertsForEmployee(assignedEmployeeId, deviceId, dt);
        }
      }
    } catch (e) {
      console.error('[Async DailySummary ERROR]:', e);
    }
  });

    return res.json({
      success: true,
      processed: insertedCount,
      syncedAt: nowIso
    });
  } catch (err: any) {
    console.error('[Agent Events/Batch ERROR]:', err);
    return res.status(500).json({ error: err.message || 'Internal error processing events' });
  }
});

// 4. Configuration download for agent caching
agentRouter.get('/config', authenticateDevice, (req: AuthenticatedDeviceRequest, res: Response): Response | void => {
  const categories = db.prepare('SELECT id, name, color, is_work FROM categories').all();
  const rules = db.prepare('SELECT category_id, match_type, pattern, priority FROM category_rules').all();
  const blockedDomains = db.prepare('SELECT domain FROM domains WHERE is_blocked = 1').all();
  const schedule = db.prepare('SELECT * FROM work_schedules WHERE is_default = 1').get();

  return res.json({
    categories,
    rules,
    blockedDomains: blockedDomains.map((b: any) => b.domain),
    schedule
  });
});
