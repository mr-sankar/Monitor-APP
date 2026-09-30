import { db } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

export interface EvaluatedAlert {
  ruleId: string;
  ruleType: string;
  severity: string;
  title: string;
  message: string;
  details: Record<string, any>;
}

export function evaluateAlertsForEmployee(employeeId: string, deviceId: string, targetDate: string) {
  const activeRules = db.prepare(`
    SELECT * FROM alert_rules WHERE is_enabled = 1
  `).all() as Array<{
    id: string;
    name: string;
    rule_type: string;
    threshold_value: number;
    window_minutes: number;
    severity: string;
  }>;

  if (activeRules.length === 0) return;

  // Query today's metrics for this employee during working hours
  const startIso = `${targetDate}T00:00:00.000Z`;
  const endIso = `${targetDate}T23:59:59.999Z`;

  const stats = db.prepare(`
    SELECT 
      SUM(CASE WHEN is_working_hours = 1 THEN duration_seconds ELSE 0 END) as total_work_hours_duration,
      SUM(CASE WHEN is_working_hours = 1 AND is_idle = 0 THEN duration_seconds ELSE 0 END) as active_work_duration,
      SUM(CASE WHEN is_working_hours = 1 AND category_id = 'cat-youtube' THEN duration_seconds ELSE 0 END) as youtube_duration,
      SUM(CASE 
        WHEN is_working_hours = 1 AND is_idle = 0 AND category_id IN (
          SELECT id FROM categories WHERE is_work = 0
        ) THEN duration_seconds 
        ELSE 0 
      END) as non_work_active_duration
    FROM activity_events
    WHERE employee_id = ? 
      AND (start_time >= ? AND start_time <= ?)
  `).get(employeeId, startIso, endIso) as {
    total_work_hours_duration: number | null;
    active_work_duration: number | null;
    youtube_duration: number | null;
    non_work_active_duration: number | null;
  };

  const activeWorkDuration = stats?.active_work_duration || 0;
  const youtubeDuration = stats?.youtube_duration || 0;
  const nonWorkDuration = stats?.non_work_active_duration || 0;

  for (const rule of activeRules) {
    if (rule.rule_type === 'youtube_excessive') {
      // Threshold is in seconds (e.g. 1800s = 30m)
      if (youtubeDuration >= rule.threshold_value) {
        triggerAlertIfNotDuplicate(
          rule.id,
          deviceId,
          employeeId,
          rule.severity,
          'Excessive YouTube During Working Hours',
          `Employee accumulated ${Math.round(youtubeDuration / 60)} minutes of YouTube streaming during working hours (policy limit: ${Math.round(rule.threshold_value / 60)}m).`,
          {
            youtube_seconds: youtubeDuration,
            threshold_seconds: rule.threshold_value,
            date: targetDate
          },
          targetDate
        );
      }
    } else if (rule.rule_type === 'non_work_percentage') {
      // Threshold is a percentage (e.g. 20%)
      if (activeWorkDuration > 1800) { // Require at least 30 mins active time before evaluating ratio
        const nonWorkRatio = (nonWorkDuration / activeWorkDuration) * 100;
        if (nonWorkRatio >= rule.threshold_value) {
          triggerAlertIfNotDuplicate(
            rule.id,
            deviceId,
            employeeId,
            rule.severity,
            'High Non-Work Activity Ratio',
            `Non-work categories accounted for ${Math.round(nonWorkRatio)}% of active working hours today (policy limit: ${rule.threshold_value}%).`,
            {
              non_work_ratio: Math.round(nonWorkRatio),
              threshold_percent: rule.threshold_value,
              non_work_seconds: nonWorkDuration,
              active_work_seconds: activeWorkDuration,
              date: targetDate
            },
            targetDate
          );
        }
      }
    }
  }
}

export function checkBlockedDomainAccess(
  deviceId: string,
  employeeId: string,
  domain: string,
  eventTime: string
) {
  if (!domain) return;

  const blocked = db.prepare(`
    SELECT * FROM domains WHERE domain = ? AND is_blocked = 1
  `).get(domain.toLowerCase()) as { domain: string } | undefined;

  if (blocked) {
    const rule = db.prepare(`
      SELECT * FROM alert_rules WHERE rule_type = 'blocked_domain' AND is_enabled = 1 LIMIT 1
    `).get() as { id: string; severity: string } | undefined;

    triggerAlertIfNotDuplicate(
      rule?.id || null,
      deviceId,
      employeeId,
      rule?.severity || 'critical',
      'Restricted Domain Access Attempted',
      `Employee attempted to access company-restricted domain: ${blocked.domain}`,
      { domain: blocked.domain, event_time: eventTime },
      eventTime.substring(0, 10)
    );
  }
}

function triggerAlertIfNotDuplicate(
  ruleId: string | null,
  deviceId: string,
  employeeId: string,
  severity: string,
  title: string,
  message: string,
  details: Record<string, any>,
  dateStr: string
) {
  // Prevent spamming duplicate alerts on the same day for the same rule & employee
  const existing = db.prepare(`
    SELECT id FROM alerts 
    WHERE employee_id = ? 
      AND title = ? 
      AND status = 'open'
      AND substr(triggered_at, 1, 10) = ?
    LIMIT 1
  `).get(employeeId, title, dateStr);

  if (existing) {
    return; // Already triggered today
  }

  const insertAlert = db.prepare(`
    INSERT INTO alerts (
      id, alert_rule_id, device_id, employee_id, triggered_at,
      severity, title, message, details_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `);

  insertAlert.run(
    uuidv4(),
    ruleId,
    deviceId,
    employeeId,
    new Date().toISOString(),
    severity,
    title,
    message,
    JSON.stringify(details)
  );
}

export function checkDeviceDisconnections() {
  const now = Date.now();
  const onlineCutoff = new Date(now - 90 * 1000).toISOString(); // 90 seconds (online margin)
  const stoppedCutoff = new Date(now - 5 * 60 * 1000).toISOString(); // 5 minutes (stopped threshold)
  const recentCutoff = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 48 hours

  // Query devices that were recently active but missed heartbeats for over 5 minutes
  const stoppedDevices = db.prepare(`
    SELECT 
      d.id, d.device_identifier, d.hostname, d.last_seen_at,
      da.employee_id, e.name as employee_name, e.emp_code
    FROM devices d
    LEFT JOIN device_assignments da ON da.device_id = d.id AND da.is_active = 1
    LEFT JOIN employees e ON e.id = da.employee_id
    WHERE d.status = 'active'
      AND d.last_seen_at < ?
      AND d.last_seen_at >= ?
  `).all(stoppedCutoff, recentCutoff) as Array<{
    id: string;
    device_identifier: string;
    hostname: string;
    last_seen_at: string;
    employee_id: string | null;
    employee_name: string | null;
    emp_code: string | null;
  }>;

  for (const dev of stoppedDevices) {
    const empId = dev.employee_id || 'emp-unassigned';
    const empName = dev.employee_name ? `${dev.employee_name} (${dev.emp_code})` : 'Unassigned';
    const alertTitle = `⚠️ Agent Stopped: ${dev.hostname}`;

    // Check if an open disconnection alert already exists for this device
    const existing = db.prepare(`
      SELECT id FROM alerts
      WHERE device_id = ?
        AND title LIKE '%Agent Stopped%'
        AND status = 'open'
      LIMIT 1
    `).get(dev.id);

    if (!existing) {
      const elapsedMinutes = Math.max(1, Math.round((now - new Date(dev.last_seen_at).getTime()) / 60000));
      const message = `Productivity monitoring agent on laptop ${dev.hostname} (${empName}) stopped sending heartbeats (offline for ${elapsedMinutes}m). The agent process may have been terminated.`;
      
      const insertAlert = db.prepare(`
        INSERT INTO alerts (
          id, alert_rule_id, device_id, employee_id, triggered_at,
          severity, title, message, details_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `);

      insertAlert.run(
        uuidv4(),
        'ar-offline',
        dev.id,
        empId,
        new Date().toISOString(),
        'critical',
        alertTitle,
        message,
        JSON.stringify({
          device_id: dev.id,
          device_identifier: dev.device_identifier,
          hostname: dev.hostname,
          last_seen_at: dev.last_seen_at,
          employee: empName,
          reason: 'process_stopped_or_unreachable'
        })
      );
    }
  }

  // Also auto-resolve disconnection alerts for devices that came back online
  const onlineDevices = db.prepare(`
    SELECT id FROM devices WHERE status = 'active' AND last_seen_at >= ?
  `).all(onlineCutoff) as Array<{ id: string }>;

  for (const dev of onlineDevices) {
    resolveDeviceDisconnectionAlerts(dev.id);
  }
}

export function resolveDeviceDisconnectionAlerts(deviceId: string) {
  db.prepare(`
    UPDATE alerts 
    SET status = 'resolved' 
    WHERE device_id = ? 
      AND title LIKE '%Agent Stopped%' 
      AND status = 'open'
  `).run(deviceId);
}

