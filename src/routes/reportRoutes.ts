import { Router, Response } from 'express';
import { db } from '../db/database.js';
import { authenticateAdmin, AuthenticatedAdminRequest } from '../middleware/auth.js';
import { updateDailySummary } from '../services/aggregator.js';

export const reportRouter = Router();
reportRouter.use(authenticateAdmin);

// 1. Productivity Summary Report
reportRouter.get('/productivity', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const today = new Date().toISOString().substring(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().substring(0, 10);
  const startDate = (req.query.startDate as string) || thirtyDaysAgo;
  const endDate = (req.query.endDate as string) || today;
  const department = req.query.department as string;

  // Ensure today's active device summaries are refreshed
  try {
    const todayStr = new Date().toISOString().substring(0, 10);
    const activePairs = db.prepare(`
      SELECT DISTINCT employee_id, device_id 
      FROM activity_events 
      WHERE substr(start_time, 1, 10) = ? AND employee_id != 'emp-unassigned'
    `).all(todayStr) as Array<{ employee_id: string; device_id: string }>;
    
    for (const p of activePairs) {
      updateDailySummary(p.employee_id, p.device_id, todayStr);
    }
  } catch (err) {
    // Non-blocking
  }

  let query = `
    SELECT 
      ds.date,
      COALESCE(e.emp_code, 'UNASSIGNED') as emp_code,
      COALESCE(e.name, 'Unassigned / Hardware Pool') as employee_name,
      COALESCE(e.department, 'IT Operations') as department,
      COALESCE(d.device_identifier, ds.device_id) as device_identifier,
      ds.total_time_seconds,
      ds.active_time_seconds,
      ds.idle_time_seconds,
      ds.work_time_seconds,
      ds.non_work_time_seconds,
      ds.youtube_seconds,
      ds.social_media_seconds,
      ds.entertainment_seconds
    FROM daily_summaries ds
    LEFT JOIN employees e ON ds.employee_id = e.id
    LEFT JOIN devices d ON ds.device_id = d.id
    WHERE ds.date >= ? AND ds.date <= ? AND ds.employee_id != 'emp-unassigned'
  `;

  const params: any[] = [startDate, endDate];
  if (department) {
    if (department.toLowerCase() === 'it') {
      query += " AND (e.department = 'IT' OR e.department LIKE 'IT%')";
    } else if (department.toLowerCase() === 'non it' || department.toLowerCase() === 'non-it') {
      query += " AND (e.department = 'Non IT' OR (e.department NOT LIKE 'IT%' AND e.department != 'IT'))";
    } else {
      query += ' AND e.department = ?';
      params.push(department);
    }
  }
  query += ' ORDER BY ds.date DESC, ds.work_time_seconds DESC';

  const rows = db.prepare(query).all(...params) as Array<any>;

  const data = rows.map((r) => {
    const active = r.active_time_seconds || 0;
    const workSecs = r.work_time_seconds || 0;
    const nonWorkSecs = r.non_work_time_seconds || 0;

    return {
      date: r.date,
      empCode: r.emp_code,
      employeeName: r.employee_name,
      department: r.department,
      device: r.device_identifier,
      totalHours: +(r.total_time_seconds / 3600).toFixed(2),
      activeHours: +(active / 3600).toFixed(2),
      idleHours: +(r.idle_time_seconds / 3600).toFixed(2),
      workHours: +(workSecs / 3600).toFixed(2),
      nonWorkHours: +(nonWorkSecs / 3600).toFixed(2),
      youtubeMinutes: Math.round(r.youtube_seconds / 60),
      socialMediaMinutes: Math.round(r.social_media_seconds / 60),
      entertainmentMinutes: Math.round(r.entertainment_seconds / 60),
      workUtilizationPercent: active > 0 ? Math.round((workSecs / active) * 100) : 0,
      nonWorkPercent: active > 0 ? Math.round((nonWorkSecs / active) * 100) : 0
    };
  });

  return res.json({ startDate, endDate, records: data });
});

// 2. YouTube & Entertainment Deep-Dive Report
reportRouter.get('/youtube-entertainment', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);

  const rows = db.prepare(`
    SELECT 
      e.emp_code,
      e.name as employee_name,
      e.department,
      SUM(CASE WHEN e_act.category_id = 'cat-youtube' THEN e_act.duration_seconds ELSE 0 END) as youtube_seconds,
      SUM(CASE WHEN e_act.category_id = 'cat-social' THEN e_act.duration_seconds ELSE 0 END) as social_seconds,
      SUM(CASE WHEN e_act.category_id = 'cat-ent' THEN e_act.duration_seconds ELSE 0 END) as entertainment_seconds,
      SUM(CASE WHEN e_act.is_working_hours = 1 AND e_act.category_id = 'cat-youtube' THEN e_act.duration_seconds ELSE 0 END) as youtube_work_hours_seconds
    FROM employees e
    LEFT JOIN activity_events e_act ON e_act.employee_id = e.id AND substr(e_act.start_time, 1, 10) = ?
    WHERE e.id != 'emp-unassigned'
    GROUP BY e.id, e.emp_code, e.name, e.department
    ORDER BY youtube_work_hours_seconds DESC
  `).all(date) as Array<any>;

  const records = rows.map((r) => ({
    empCode: r.emp_code,
    employeeName: r.employee_name,
    department: r.department,
    youtubeMinutes: Math.round(r.youtube_seconds / 60),
    youtubeWorkHoursMinutes: Math.round(r.youtube_work_hours_seconds / 60),
    socialMediaMinutes: Math.round(r.social_seconds / 60),
    entertainmentMinutes: Math.round(r.entertainment_seconds / 60),
    policyFlag: r.youtube_work_hours_seconds > 1800 // > 30 mins
  }));

  return res.json({ date, records });
});

// 3. Export CSV Report
reportRouter.get('/export-csv', (req: AuthenticatedAdminRequest, res: Response): void => {
  const today = new Date().toISOString().substring(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().substring(0, 10);
  const startDate = (req.query.startDate as string) || thirtyDaysAgo;
  const endDate = (req.query.endDate as string) || today;

  const rows = db.prepare(`
    SELECT 
      ds.date,
      COALESCE(e.emp_code, 'UNASSIGNED') as emp_code,
      COALESCE(e.name, 'Unassigned / Hardware Pool') as employee_name,
      COALESCE(e.department, 'IT Operations') as department,
      COALESCE(d.device_identifier, ds.device_id) as device_identifier,
      ds.active_time_seconds,
      ds.idle_time_seconds,
      ds.work_time_seconds,
      ds.non_work_time_seconds,
      ds.youtube_seconds,
      ds.social_media_seconds
    FROM daily_summaries ds
    LEFT JOIN employees e ON ds.employee_id = e.id
    LEFT JOIN devices d ON ds.device_id = d.id
    WHERE ds.date >= ? AND ds.date <= ? AND ds.employee_id != 'emp-unassigned'
    ORDER BY ds.date DESC, e.emp_code ASC
  `).all(startDate, endDate) as Array<any>;

  const headers = [
    'Date',
    'Employee Code',
    'Employee Name',
    'Department',
    'Device ID',
    'Active Hours',
    'Idle Hours',
    'Work Hours',
    'Non-Work Hours',
    'Work Utilization %',
    'YouTube (Mins)',
    'Social Media (Mins)'
  ];

  const csvRows = [headers.join(',')];

  for (const r of rows) {
    const active = r.active_time_seconds || 0;
    const work = r.work_time_seconds || 0;
    const util = active > 0 ? Math.round((work / active) * 100) : 0;

    csvRows.push([
      r.date,
      `"${r.emp_code}"`,
      `"${r.employee_name}"`,
      `"${r.department}"`,
      `"${r.device_identifier}"`,
      (active / 3600).toFixed(2),
      (r.idle_time_seconds / 3600).toFixed(2),
      (work / 3600).toFixed(2),
      (r.non_work_time_seconds / 3600).toFixed(2),
      `${util}%`,
      Math.round(r.youtube_seconds / 60),
      Math.round(r.social_media_seconds / 60)
    ].join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="productivity-report-${startDate}-to-${endDate}.csv"`);
  res.send(csvRows.join('\n'));
});
