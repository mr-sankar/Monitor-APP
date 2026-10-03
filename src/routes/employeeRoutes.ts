import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/database.js';
import { authenticateAdmin, AuthenticatedAdminRequest } from '../middleware/auth.js';
import { logAuditAction } from '../middleware/audit.js';
import { getEmployeeProductivity, updateDailySummary } from '../services/aggregator.js';

export const employeeRouter = Router();
employeeRouter.use(authenticateAdmin);

employeeRouter.get('/', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const isSimple = req.query.simple === 'true' || req.query.lite === 'true';
  if (isSimple) {
    const simpleList = db.prepare(`
      SELECT id, emp_code as empCode, name, email, department, status
      FROM employees
      WHERE id != 'emp-unassigned'
      ORDER BY name ASC
    `).all();
    return res.json({ employees: simpleList });
  }

  const today = new Date().toISOString().substring(0, 10);
  const onlineCutoff = new Date(Date.now() - 90 * 1000).toISOString(); // 90 seconds (online margin)

  const employees = db.prepare(`
    SELECT 
      e.id, e.emp_code, e.name, e.email, e.department, e.status, e.created_at,
      d.id as device_id, d.device_identifier, d.hostname, d.os_version, d.last_seen_at,
      COALESCE(SUM(ds.work_time_seconds), 0) as work_time_seconds,
      COALESCE(SUM(ds.active_time_seconds), 0) as active_time_seconds,
      COALESCE(SUM(ds.idle_time_seconds), 0) as idle_time_seconds,
      COALESCE(SUM(ds.total_time_seconds), 0) as total_time_seconds,
      ls.app_name as live_app_name, ls.window_title as live_window_title, ls.domain as live_domain, ls.is_idle as live_is_idle
    FROM employees e
    LEFT JOIN device_assignments da ON da.employee_id = e.id AND da.is_active = 1
    LEFT JOIN devices d ON d.id = da.device_id
    LEFT JOIN device_live_status ls ON ls.device_id = d.id
    LEFT JOIN daily_summaries ds ON ds.employee_id = e.id AND ds.date = ?
    WHERE e.id != 'emp-unassigned'
    GROUP BY e.id
    ORDER BY e.emp_code ASC
  `).all(today) as Array<any>;

  const latestEventsStmt = db.prepare(`
    SELECT app_name, domain, window_title_sanitized, is_idle, start_time, end_time
    FROM activity_events
    WHERE employee_id = ? AND substr(start_time, 1, 10) = ?
    ORDER BY start_time DESC
    LIMIT 1
  `);

  const formatted = employees.map((emp) => {
    const isOnline = emp.last_seen_at && emp.last_seen_at >= onlineCutoff;

    let currentAppDisplay = null;
    if (isOnline) {
      if (emp.live_app_name) {
        if (emp.live_is_idle === 1) {
          currentAppDisplay = 'Idle / Away';
        } else if (emp.live_domain) {
          currentAppDisplay = `${emp.live_app_name} (${emp.live_domain})`;
        } else {
          currentAppDisplay = emp.live_app_name;
        }
      } else {
        const latestEvent = latestEventsStmt.get(emp.id, today) as any;
        if (latestEvent) {
          if (latestEvent.is_idle === 1) {
            currentAppDisplay = 'Idle / Away';
          } else if (latestEvent.domain) {
            currentAppDisplay = `${latestEvent.app_name} (${latestEvent.domain})`;
          } else {
            currentAppDisplay = latestEvent.app_name;
          }
        }
      }
    }

    return {
      id: emp.id,
      empCode: emp.emp_code,
      name: emp.name,
      email: emp.email,
      department: emp.department,
      status: emp.status,
      workTimeSeconds: emp.work_time_seconds || 0,
      activeTimeSeconds: emp.active_time_seconds || 0,
      idleTimeSeconds: emp.idle_time_seconds || 0,
      totalTimeSeconds: emp.total_time_seconds || 0,
      currentApp: currentAppDisplay,
      device: emp.device_id
        ? {
            id: emp.device_id,
            identifier: emp.device_identifier,
            hostname: emp.hostname,
            os: emp.os_version,
            isOnline,
            lastSeenAt: emp.last_seen_at
          }
        : null
    };
  });

  return res.json({ employees: formatted });
});

employeeRouter.get('/:id/productivity', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const empId = String(req.params.id);
  const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);

  const metrics = getEmployeeProductivity(empId, date);
  if (!metrics) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  // Also fetch schedule info
  const schedule = db.prepare('SELECT * FROM work_schedules WHERE is_default = 1').get() as any;

  return res.json({
    metrics,
    schedule: schedule
      ? {
          name: schedule.name,
          startTime: schedule.work_start_time,
          endTime: schedule.work_end_time,
          breakStart: schedule.break_start_time,
          breakEnd: schedule.break_end_time
        }
      : null
  });
});

employeeRouter.post('/', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const { empCode, name, email, department } = req.body;

  if (!empCode || !name || !email) {
    return res.status(400).json({ error: 'empCode, name, and email are required' });
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO employees (id, emp_code, name, email, department, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).run(id, empCode, name, email, department || 'General', now);

    logAuditAction(req, 'CREATE_EMPLOYEE', 'employees', id, { empCode, name, email });
    return res.status(201).json({ id, empCode, name, email, department });
  } catch (err: any) {
    return res.status(400).json({ error: 'Employee code or email already exists' });
  }
});

employeeRouter.put('/:id', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const employeeId = String(req.params.id);
  const { empCode, name, email, department, status } = req.body;

  if (employeeId === 'emp-unassigned') {
    return res.status(400).json({ error: 'System unassigned pool cannot be modified' });
  }

  const existing = db.prepare('SELECT id, emp_code, name, email, department, status FROM employees WHERE id = ?').get(employeeId) as any;
  if (!existing) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  const updatedCode = empCode ? String(empCode).trim() : existing.emp_code;
  const updatedName = name ? String(name).trim() : existing.name;
  const updatedEmail = email ? String(email).trim() : existing.email;
  const updatedDept = department !== undefined ? String(department).trim() : existing.department;
  const updatedStatus = status ? String(status).trim() : existing.status;

  if (!updatedCode || !updatedName || !updatedEmail) {
    return res.status(400).json({ error: 'Employee code, name, and email cannot be empty' });
  }

  // Check code uniqueness against other employees
  const codeConflict = db.prepare('SELECT id FROM employees WHERE LOWER(emp_code) = LOWER(?) AND id != ?').get(updatedCode, employeeId);
  if (codeConflict) {
    return res.status(400).json({ error: `Employee code "${updatedCode}" is already in use by another employee.` });
  }

  // Check email uniqueness against other employees
  const emailConflict = db.prepare('SELECT id FROM employees WHERE LOWER(email) = LOWER(?) AND id != ?').get(updatedEmail, employeeId);
  if (emailConflict) {
    return res.status(400).json({ error: `Email address "${updatedEmail}" is already in use by another employee.` });
  }

  try {
    db.prepare(`
      UPDATE employees 
      SET emp_code = ?, name = ?, email = ?, department = ?, status = ?
      WHERE id = ?
    `).run(updatedCode, updatedName, updatedEmail, updatedDept || 'General', updatedStatus, employeeId);

    logAuditAction(req, 'UPDATE_EMPLOYEE', 'employees', employeeId, {
      old: existing,
      new: { emp_code: updatedCode, name: updatedName, email: updatedEmail, department: updatedDept, status: updatedStatus }
    });

    return res.json({
      success: true,
      employee: {
        id: employeeId,
        empCode: updatedCode,
        name: updatedName,
        email: updatedEmail,
        department: updatedDept,
        status: updatedStatus
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to update employee' });
  }
});

employeeRouter.post('/:id/assign-device', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const employeeId = String(req.params.id);
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  // Deactivate prior assignments for this device or employee
  db.prepare('UPDATE device_assignments SET is_active = 0, unassigned_at = ? WHERE employee_id = ? OR device_id = ?')
    .run(new Date().toISOString(), employeeId, String(deviceId));

  // Insert new active assignment
  const assignmentId = uuidv4();
  db.prepare(`
    INSERT INTO device_assignments (id, device_id, employee_id, assigned_at, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run(assignmentId, String(deviceId), employeeId, new Date().toISOString());

  // Retroactively link unassigned events to the newly assigned employee
  db.prepare(`
    UPDATE activity_events 
    SET employee_id = ? 
    WHERE device_id = ? AND (employee_id = 'emp-unassigned' OR employee_id IS NULL OR employee_id = '')
  `).run(employeeId, String(deviceId));

  // Re-aggregate employee's daily productivity summary
  const today = new Date().toISOString().substring(0, 10);
  try {
    updateDailySummary(employeeId, String(deviceId), today);
    db.prepare("DELETE FROM daily_summaries WHERE device_id = ? AND employee_id = 'emp-unassigned'").run(String(deviceId));
  } catch (err) {
    console.warn('[AssignDevice] Could not refresh daily summary:', err);
  }

  logAuditAction(req, 'ASSIGN_DEVICE', 'device_assignments', assignmentId, { employeeId, deviceId });

  return res.json({ success: true, assignmentId, employeeId, deviceId });
});

employeeRouter.post('/:id/unassign-device', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const employeeId = String(req.params.id);

  db.prepare('DELETE FROM device_assignments WHERE employee_id = ?').run(employeeId);
  logAuditAction(req, 'UNASSIGN_DEVICE', 'employees', employeeId);

  return res.json({ success: true, message: 'Device unassigned from employee successfully' });
});

employeeRouter.delete('/:id', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const employeeId = String(req.params.id);

  if (employeeId === 'emp-unassigned') {
    return res.status(400).json({ error: 'System unassigned pool cannot be deleted' });
  }

  // 1. Delete device assignments
  db.prepare('DELETE FROM device_assignments WHERE employee_id = ?').run(employeeId);
  // 2. Clean up associated activity events, summaries, and alerts
  db.prepare('DELETE FROM activity_events WHERE employee_id = ?').run(employeeId);
  db.prepare('DELETE FROM daily_summaries WHERE employee_id = ?').run(employeeId);
  db.prepare('DELETE FROM alerts WHERE employee_id = ?').run(employeeId);
  // 3. Delete employee record
  db.prepare('DELETE FROM employees WHERE id = ?').run(employeeId);

  logAuditAction(req, 'DELETE_EMPLOYEE', 'employees', employeeId);

  return res.json({ success: true, message: 'Employee removed successfully' });
});
