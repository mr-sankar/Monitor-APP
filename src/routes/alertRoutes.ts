import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/database.js';
import { authenticateAdmin, AuthenticatedAdminRequest } from '../middleware/auth.js';
import { logAuditAction } from '../middleware/audit.js';

export const alertRouter = Router();
alertRouter.use(authenticateAdmin);

// 1. Alerts Inbox
alertRouter.get('/', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const status = req.query.status as string; // 'open', 'acknowledged', 'resolved'

  let query = `
    SELECT 
      a.id, a.alert_rule_id, a.device_id, a.employee_id, a.triggered_at,
      a.severity, a.title, a.message, a.details_json, a.status,
      a.resolved_by, a.resolved_at,
      e.emp_code, e.name as employee_name, e.department,
      d.device_identifier, d.hostname
    FROM alerts a
    LEFT JOIN employees e ON a.employee_id = e.id
    LEFT JOIN devices d ON a.device_id = d.id
  `;

  const params: any[] = [];
  if (status) {
    query += ' WHERE a.status = ?';
    params.push(status);
  }
  query += ' ORDER BY a.triggered_at DESC LIMIT 100';

  const rows = db.prepare(query).all(...params) as Array<any>;

  const alerts = rows.map((r) => ({
    id: r.id,
    ruleId: r.alert_rule_id,
    deviceId: r.device_id,
    deviceIdentifier: r.device_identifier,
    hostname: r.hostname,
    employeeId: r.employee_id,
    employeeCode: r.emp_code,
    employeeName: r.employee_name,
    department: r.department,
    triggeredAt: r.triggered_at,
    severity: r.severity,
    title: r.title,
    message: r.message,
    details: JSON.parse(r.details_json || '{}'),
    status: r.status,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at
  }));

  return res.json({ alerts });
});

// 2. Update Alert Status (Acknowledge / Resolve)
alertRouter.patch('/:id', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const alertId = String(req.params.id);
  const { status } = req.body; // 'acknowledged', 'resolved', 'open'

  if (!['open', 'acknowledged', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Status must be open, acknowledged, or resolved' });
  }

  const now = new Date().toISOString();
  const adminEmail = req.admin!.email;

  db.prepare(`
    UPDATE alerts 
    SET status = ?, resolved_by = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, status === 'resolved' ? adminEmail : null, status === 'resolved' ? now : null, alertId);

  logAuditAction(req, 'UPDATE_ALERT_STATUS', 'alerts', alertId, { status });

  return res.json({ success: true, alertId, status });
});

// 3. List Alert Rules
alertRouter.get('/rules', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const rules = db.prepare('SELECT * FROM alert_rules ORDER BY severity DESC, name ASC').all();
  return res.json({ rules });
});

// 4. Create Alert Rule
alertRouter.post('/rules', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  try {
    const { name, ruleType, thresholdValue, windowMinutes, severity } = req.body;

    const trimmedName = String(name || '').trim() || 'Custom Policy Rule';
    const trimmedType = String(ruleType || '').trim() || 'youtube_excessive';
    const numThreshold = Number(thresholdValue) > 0 ? Number(thresholdValue) : 1800;
    const finalSeverity = severity || 'high';

    const id = uuidv4();
    db.prepare(`
      INSERT INTO alert_rules (id, name, rule_type, threshold_value, window_minutes, severity, is_enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(id, trimmedName, trimmedType, numThreshold, windowMinutes || 60, finalSeverity);

    logAuditAction(req, 'CREATE_ALERT_RULE', 'alert_rules', id, { name: trimmedName, ruleType: trimmedType, thresholdValue: numThreshold });

    return res.status(201).json({
      id,
      name: trimmedName,
      ruleType: trimmedType,
      rule_type: trimmedType,
      thresholdValue: numThreshold,
      threshold_value: numThreshold,
      severity: finalSeverity,
      is_enabled: 1
    });
  } catch (err: any) {
    console.error('Failed to create alert rule:', err);
    return res.status(500).json({ error: err.message || 'Failed to create alert rule' });
  }
});

// 5. Update Alert Rule
alertRouter.put('/rules/:id', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const ruleId = String(req.params.id);
  const { name, thresholdValue, windowMinutes, severity, isEnabled } = req.body;

  db.prepare(`
    UPDATE alert_rules 
    SET name = COALESCE(?, name),
        threshold_value = COALESCE(?, threshold_value),
        window_minutes = COALESCE(?, window_minutes),
        severity = COALESCE(?, severity),
        is_enabled = COALESCE(?, is_enabled)
    WHERE id = ?
  `).run(
    name ?? null,
    thresholdValue !== undefined ? Number(thresholdValue) : null,
    windowMinutes !== undefined ? Number(windowMinutes) : null,
    severity ?? null,
    isEnabled === undefined ? null : isEnabled ? 1 : 0,
    ruleId
  );

  logAuditAction(req, 'UPDATE_ALERT_RULE', 'alert_rules', ruleId, req.body);

  return res.json({ success: true, message: 'Rule updated' });
});

// 6. Delete Alert Rule
alertRouter.delete('/rules/:id', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  try {
    const ruleId = String(req.params.id);
    const existingRule = db.prepare('SELECT name FROM alert_rules WHERE id = ?').get(ruleId) as { name?: string } | undefined;
    const ruleName = existingRule?.name || 'Compliance Policy Rule';

    // Detach any alerts referencing this rule so foreign key does not block deletion
    db.prepare('UPDATE alerts SET alert_rule_id = NULL WHERE alert_rule_id = ?').run(ruleId);

    // Remove rule
    const result = db.prepare('DELETE FROM alert_rules WHERE id = ?').run(ruleId);
    logAuditAction(req, 'DELETE_ALERT_RULE', 'alert_rules', ruleId, { name: ruleName });

    return res.json({ success: true, message: 'Alert rule deleted successfully', changes: result.changes });
  } catch (err: any) {
    console.error('Failed to delete alert rule:', err);
    return res.status(500).json({ error: err.message || 'Failed to delete alert rule' });
  }
});

// 7. Clear All Alerts
alertRouter.delete('/clear/all', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  try {
    const result = db.prepare('DELETE FROM alerts').run();
    logAuditAction(req, 'CLEAR_ALL_ALERTS', 'alerts', 'all', { count: result.changes });

    return res.json({ success: true, message: 'All alerts cleared successfully', changes: result.changes });
  } catch (err: any) {
    console.error('Failed to clear all alerts:', err);
    return res.status(500).json({ error: err.message || 'Failed to clear all alerts' });
  }
});

// 8. Clear Resolved Alerts (MUST be defined before /:id)
alertRouter.delete('/clear/resolved', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  try {
    const result = db.prepare("DELETE FROM alerts WHERE status = 'resolved'").run();
    logAuditAction(req, 'CLEAR_RESOLVED_ALERTS', 'alerts', 'all', { count: result.changes });

    return res.json({ success: true, message: 'Resolved alerts cleared successfully', changes: result.changes });
  } catch (err: any) {
    console.error('Failed to clear resolved alerts:', err);
    return res.status(500).json({ error: err.message || 'Failed to clear resolved alerts' });
  }
});

// 9. Delete Individual Alert
alertRouter.delete('/:id', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  try {
    const alertId = String(req.params.id);

    const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(alertId);
    logAuditAction(req, 'DELETE_ALERT', 'alerts', alertId);

    return res.json({ success: true, message: 'Alert deleted successfully', changes: result.changes });
  } catch (err: any) {
    console.error('Failed to delete alert:', err);
    return res.status(500).json({ error: err.message || 'Failed to delete alert' });
  }
});

