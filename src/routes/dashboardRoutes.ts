import { Router, Response } from 'express';
import { db } from '../db/database.js';
import { authenticateAdmin, AuthenticatedAdminRequest } from '../middleware/auth.js';
import { getCompanyOverview, updateDailySummary } from '../services/aggregator.js';

export const dashboardRouter = Router();

// Protect all dashboard routes
dashboardRouter.use(authenticateAdmin);

dashboardRouter.get('/summary', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);
  const overview = getCompanyOverview(date);
  return res.json(overview);
});

function getDateRange(dateStr: string) {
  const startIso = `${dateStr}T00:00:00.000Z`;
  const endIso = `${dateStr}T23:59:59.999Z`;
  return { startIso, endIso };
}

dashboardRouter.get('/categories', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);
  const { startIso, endIso } = getDateRange(date);

  const rows = db.prepare(`
    SELECT 
      c.id, c.name, c.color, c.is_work,
      COALESCE(SUM(e.duration_seconds), 0) as duration_seconds
    FROM categories c
    LEFT JOIN activity_events e ON e.category_id = c.id 
      AND (e.start_time >= ? AND e.start_time <= ?)
    GROUP BY c.id, c.name, c.color, c.is_work
    ORDER BY duration_seconds DESC
  `).all(startIso, endIso) as Array<{
    id: string;
    name: string;
    color: string;
    is_work: number;
    duration_seconds: number;
  }>;

  const total = rows.reduce((acc, curr) => acc + curr.duration_seconds, 0);

  const categories = rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    isWork: r.is_work === 1,
    durationSeconds: r.duration_seconds,
    percentage: total > 0 ? Math.round((r.duration_seconds / total) * 100) : 0
  }));

  return res.json({ date, totalDurationSeconds: total, categories });
});

dashboardRouter.get('/top-apps', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);
  const { startIso, endIso } = getDateRange(date);

  const rows = db.prepare(`
    SELECT 
      COALESCE(app_name, process_name) as name,
      c.name as category_name,
      c.color as category_color,
      c.is_work,
      SUM(duration_seconds) as duration_seconds
    FROM activity_events e
    JOIN categories c ON e.category_id = c.id
    WHERE (e.start_time >= ? AND e.start_time <= ?) AND is_idle = 0
    GROUP BY COALESCE(app_name, process_name), c.name, c.color, c.is_work
    ORDER BY duration_seconds DESC
    LIMIT 10
  `).all(startIso, endIso) as Array<{
    name: string;
    category_name: string;
    category_color: string;
    is_work: number;
    duration_seconds: number;
  }>;

  const totalActive = rows.reduce((acc, r) => acc + r.duration_seconds, 0);

  const apps = rows.map((r) => ({
    name: r.name,
    categoryName: r.category_name,
    categoryColor: r.category_color,
    isWork: r.is_work === 1,
    durationSeconds: r.duration_seconds,
    percentage: totalActive > 0 ? Math.round((r.duration_seconds / totalActive) * 100) : 0
  }));

  return res.json({ date, apps });
});

dashboardRouter.get('/top-domains', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);
  const { startIso, endIso } = getDateRange(date);

  const rows = db.prepare(`
    SELECT 
      domain,
      c.name as category_name,
      c.color as category_color,
      c.is_work,
      SUM(duration_seconds) as duration_seconds,
      COUNT(DISTINCT employee_id) as employee_count
    FROM activity_events e
    JOIN categories c ON e.category_id = c.id
    WHERE (e.start_time >= ? AND e.start_time <= ?)
      AND domain IS NOT NULL 
      AND is_idle = 0
    GROUP BY domain, c.name, c.color, c.is_work
    ORDER BY duration_seconds DESC
    LIMIT 10
  `).all(startIso, endIso) as Array<{
    domain: string;
    category_name: string;
    category_color: string;
    is_work: number;
    duration_seconds: number;
    employee_count: number;
  }>;

  const totalWeb = rows.reduce((acc, r) => acc + r.duration_seconds, 0);

  const domains = rows.map((r) => ({
    domain: r.domain,
    categoryName: r.category_name,
    categoryColor: r.category_color,
    isWork: r.is_work === 1,
    durationSeconds: r.duration_seconds,
    employeeCount: r.employee_count,
    percentage: totalWeb > 0 ? Math.round((r.duration_seconds / totalWeb) * 100) : 0
  }));

  return res.json({ date, domains });
});

dashboardRouter.get('/hourly-activity', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);
  const { startIso, endIso } = getDateRange(date);

  // Build hourly slots from 08:00 to 19:00
  const hourlySlots: Record<number, { hour: number; workSecs: number; nonWorkSecs: number; idleSecs: number; ytSecs: number }> = {};
  for (let h = 8; h <= 19; h++) {
    hourlySlots[h] = { hour: h, workSecs: 0, nonWorkSecs: 0, idleSecs: 0, ytSecs: 0 };
  }

  const events = db.prepare(`
    SELECT 
      start_time,
      duration_seconds,
      is_idle,
      c.is_work,
      c.id as category_id
    FROM activity_events e
    JOIN categories c ON e.category_id = c.id
    WHERE (start_time >= ? AND start_time <= ?)
  `).all(startIso, endIso) as Array<{
    start_time: string;
    duration_seconds: number;
    is_idle: number;
    is_work: number;
    category_id: string;
  }>;

  for (const ev of events) {
    const h = new Date(ev.start_time).getUTCHours();
    if (hourlySlots[h]) {
      if (ev.is_idle === 1) {
        hourlySlots[h].idleSecs += ev.duration_seconds;
      } else if (ev.category_id === 'cat-youtube') {
        hourlySlots[h].ytSecs += ev.duration_seconds;
        hourlySlots[h].nonWorkSecs += ev.duration_seconds;
      } else if (ev.is_work === 1) {
        hourlySlots[h].workSecs += ev.duration_seconds;
      } else {
        hourlySlots[h].nonWorkSecs += ev.duration_seconds;
      }
    }
  }

  const timeline = Object.values(hourlySlots).map((slot) => ({
    hour: `${String(slot.hour).padStart(2, '0')}:00`,
    workMinutes: Math.round(slot.workSecs / 60),
    nonWorkMinutes: Math.round(slot.nonWorkSecs / 60),
    idleMinutes: Math.round(slot.idleSecs / 60),
    youtubeMinutes: Math.round(slot.ytSecs / 60)
  }));

  return res.json({ date, timeline });
});

dashboardRouter.get('/trends', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  // Aggregate last 7 days
  const rows = db.prepare(`
    SELECT 
      date,
      SUM(work_time_seconds) as work_seconds,
      SUM(non_work_time_seconds) as non_work_seconds,
      SUM(youtube_seconds) as youtube_seconds,
      SUM(idle_time_seconds) as idle_seconds,
      SUM(active_time_seconds) as active_seconds
    FROM daily_summaries
    GROUP BY date
    ORDER BY date DESC
    LIMIT 7
  `).all() as Array<{
    date: string;
    work_seconds: number;
    non_work_seconds: number;
    youtube_seconds: number;
    idle_seconds: number;
    active_seconds: number;
  }>;

  const trends = rows.reverse().map((r) => ({
    date: r.date,
    workHours: +(r.work_seconds / 3600).toFixed(1),
    nonWorkHours: +(r.non_work_seconds / 3600).toFixed(1),
    youtubeMinutes: Math.round(r.youtube_seconds / 60),
    idleMinutes: Math.round(r.idle_seconds / 60),
    activeHours: +(r.active_seconds / 3600).toFixed(1)
  }));

  return res.json({ trends });
});

// Dedicated fast endpoint for Present Open Applications & Tabs (LIVE NOW)
dashboardRouter.get('/live-windows', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const now = Date.now();
  const onlineCutoff = new Date(now - 90 * 1000).toISOString(); // 90 seconds (online margin)

  const liveRows = db.prepare(`
    SELECT 
      d.id as device_id, d.hostname as device_name, d.device_identifier, d.last_seen_at, d.status,
      e.id as employee_id, e.name as employee_name, e.emp_code, e.department,
      ls.app_name, ls.process_name, ls.window_title, ls.domain, ls.start_time, ls.duration_seconds, ls.is_idle, ls.updated_at
    FROM devices d
    LEFT JOIN device_assignments da ON da.device_id = d.id AND da.is_active = 1
    LEFT JOIN employees e ON e.id = da.employee_id
    LEFT JOIN device_live_status ls ON ls.device_id = d.id
    WHERE d.status = 'active' AND d.last_seen_at >= ?
    ORDER BY ls.updated_at DESC
  `).all(onlineCutoff) as Array<any>;

  const currentActiveWindows = liveRows.map((r) => {
    const startMs = r.start_time ? new Date(r.start_time).getTime() : new Date(r.updated_at || now).getTime();
    const liveSecs = startMs > 0 ? Math.max(1, Math.round((now - startMs) / 1000)) : (r.duration_seconds || 1);
    const isLocked = (r.process_name || '').toLowerCase() === 'lockapp.exe' || (r.window_title || '').toLowerCase().includes('lock screen');
    return {
      deviceId: r.device_id,
      deviceName: r.device_name || r.device_identifier || 'Laptop',
      deviceIdentifier: r.device_identifier || '',
      employeeId: r.employee_id || 'emp-unassigned',
      employeeName: r.employee_name || 'Unassigned Pool',
      employeeCode: r.emp_code || '',
      department: r.department || 'General',
      appName: isLocked ? 'Windows Lock Screen' : (r.app_name || r.process_name || 'Active Application'),
      processName: r.process_name || 'unknown.exe',
      windowTitle: isLocked ? 'Windows Lock Screen' : (r.window_title || 'Active Window'),
      domain: r.domain || null,
      startTime: r.start_time || new Date(now - liveSecs * 1000).toISOString(),
      liveDurationSeconds: liveSecs,
      isIdle: Boolean(r.is_idle || isLocked),
      lastSeenAt: r.last_seen_at
    };
  });

  return res.json({
    onlineCount: currentActiveWindows.length,
    timestamp: new Date().toISOString(),
    windows: currentActiveWindows
  });
});

dashboardRouter.get('/activity-feed', (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);
  const deviceId = req.query.deviceId as string | undefined;
  const employeeId = req.query.employeeId as string | undefined;
  const search = req.query.search as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 200, 500);

  const now = Date.now();
  const onlineCutoff = new Date(now - 90 * 1000).toISOString(); // 90 seconds (online margin)

  // 1. Query Current Active Windows for Online Devices
  let liveQuery = `
    SELECT 
      d.id as device_id, d.hostname as device_name, d.device_identifier, d.last_seen_at,
      e.id as employee_id, e.name as employee_name, e.emp_code,
      ls.app_name, ls.process_name, ls.window_title, ls.domain, ls.start_time, ls.duration_seconds, ls.is_idle, ls.updated_at
    FROM devices d
    LEFT JOIN device_assignments da ON da.device_id = d.id AND da.is_active = 1
    LEFT JOIN employees e ON e.id = da.employee_id
    LEFT JOIN device_live_status ls ON ls.device_id = d.id
    WHERE d.status = 'active' AND d.last_seen_at >= ?
  `;
  const liveParams: any[] = [onlineCutoff];
  if (deviceId) {
    liveQuery += ` AND d.id = ?`;
    liveParams.push(deviceId);
  }
  if (employeeId) {
    liveQuery += ` AND e.id = ?`;
    liveParams.push(employeeId);
  }

  const liveRows = db.prepare(liveQuery).all(...liveParams) as Array<any>;
  const currentActiveWindows = liveRows.map((r) => {
    const startMs = r.start_time ? new Date(r.start_time).getTime() : new Date(r.updated_at || now).getTime();
    const liveSecs = startMs > 0 ? Math.max(1, Math.round((now - startMs) / 1000)) : (r.duration_seconds || 1);
    const isLocked = (r.process_name || '').toLowerCase() === 'lockapp.exe' || (r.window_title || '').toLowerCase().includes('lock screen');
    return {
      deviceId: r.device_id,
      deviceName: r.device_name || r.device_identifier || 'Laptop',
      deviceIdentifier: r.device_identifier || '',
      employeeId: r.employee_id || 'emp-unassigned',
      employeeName: r.employee_name || 'Unassigned',
      employeeCode: r.emp_code || '',
      appName: isLocked ? 'Windows Lock Screen' : (r.app_name || r.process_name || 'Active Application'),
      processName: r.process_name || 'unknown.exe',
      windowTitle: isLocked ? 'Windows Lock Screen' : (r.window_title || 'Active Window'),
      domain: r.domain || null,
      startTime: r.start_time || new Date(now - liveSecs * 1000).toISOString(),
      liveDurationSeconds: liveSecs,
      isIdle: Boolean(r.is_idle || isLocked)
    };
  });

  const { startIso, endIso } = getDateRange(date);

  // 2. Query Historical & Today's Activity Events
  let query = `
    SELECT 
      e.id,
      e.device_id,
      d.hostname as device_name,
      d.device_identifier,
      d.last_seen_at as device_last_seen_at,
      e.employee_id,
      emp.name as employee_name,
      emp.emp_code,
      e.start_time,
      e.end_time,
      e.duration_seconds,
      e.app_name,
      e.process_name,
      e.window_title_sanitized,
      e.domain,
      e.is_idle,
      c.id as category_id,
      c.name as category_name,
      c.color as category_color,
      c.is_work
    FROM activity_events e
    JOIN categories c ON e.category_id = c.id
    LEFT JOIN devices d ON e.device_id = d.id
    LEFT JOIN employees emp ON e.employee_id = emp.id
    WHERE (e.start_time >= ? AND e.start_time <= ?)
  `;

  const params: any[] = [startIso, endIso];

  if (deviceId) {
    query += ` AND e.device_id = ?`;
    params.push(deviceId);
  }

  if (employeeId) {
    query += ` AND e.employee_id = ?`;
    params.push(employeeId);
  }

  if (search) {
    query += ` AND (e.app_name LIKE ? OR e.process_name LIKE ? OR e.window_title_sanitized LIKE ? OR e.domain LIKE ? OR d.device_identifier LIKE ? OR d.hostname LIKE ? OR emp.name LIKE ? OR emp.emp_code LIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s, s, s);
  }

  // Optimize: Fetch the most recent activities using the idx_activity_start_time index
  // Fetch up to 2x limit (min 200) to ensure full coverage after contiguous consolidation
  const fetchLimit = Math.max(limit * 2, 200);
  query += ` ORDER BY e.start_time DESC LIMIT ?`;
  params.push(fetchLimit);

  const rawRows = db.prepare(query).all(...params) as Array<any>;
  // Reverse to chronological ASC order so consolidation logic works identically
  const rows = rawRows.reverse();

  // Filter out 1-2s transient Windows OS background noise
  const meaningfulRows = rows.filter((r) => {
    const proc = (r.process_name || '').toLowerCase();
    const isTransientNoise = proc === 'shellexperiencehost.exe' || proc === 'searchapp.exe' || proc === 'startmenuexperiencehost.exe';
    if (isTransientNoise && r.duration_seconds <= 2) return false;
    return true;
  });

  // Consolidate contiguous activities for the same application or website tab
  const consolidated: typeof rows = [];
  for (const r of meaningfulRows) {
    const isLockOrSystem = (r.app_name || '').toLowerCase().includes('lock screen') || (r.process_name || '').toLowerCase() === 'system.exe';
    if (isLockOrSystem) {
      r.is_idle = 1;
      r.category_id = 'cat-other';
    }

    const prev = consolidated.length > 0 ? consolidated[consolidated.length - 1] : null;
    const isSameSession =
      prev &&
      prev.device_id === r.device_id &&
      prev.employee_id === r.employee_id &&
      (prev.process_name || '').toLowerCase() === (r.process_name || '').toLowerCase() &&
      (prev.domain || '').toLowerCase() === (r.domain || '').toLowerCase() &&
      prev.is_idle === r.is_idle &&
      prev.is_work === r.is_work;

    if (isSameSession && prev) {
      if (r.end_time > prev.end_time) {
        prev.end_time = r.end_time;
      }
      if (r.start_time < prev.start_time) {
        prev.start_time = r.start_time;
      }
      const startMs = new Date(prev.start_time).getTime();
      const endMs = new Date(prev.end_time).getTime();
      prev.duration_seconds = Math.max(1, Math.round((endMs - startMs) / 1000));
      if (r.window_title_sanitized && r.window_title_sanitized !== 'System Idle / Lock Screen') {
        prev.window_title_sanitized = r.window_title_sanitized;
      }
    } else {
      consolidated.push({ ...r });
    }
  }

  // Group consolidated events by device_id so device timelines are processed independently
  // (Prevents interleaving of multiple laptops from falsely triggering 'ACTIVE NOW' on past events)
  const deviceEventMap = new Map<string, Array<any>>();
  for (const item of consolidated) {
    const devId = item.device_id || 'unknown';
    if (!deviceEventMap.has(devId)) {
      deviceEventMap.set(devId, []);
    }
    deviceEventMap.get(devId)!.push(item);
  }

  // Process each device's sequence of events
  for (const [devId, devEvents] of deviceEventMap.entries()) {
    // Find the index of the latest genuinely active window for this device (skipping closed/blocked audit records)
    let latestActiveIdx = -1;
    for (let k = devEvents.length - 1; k >= 0; k--) {
      const title = (devEvents[k].window_title_sanitized || '');
      const isRestrictedClosure = title.includes('[RESTRICTED WEBSITE TAB CLOSED]') || title.includes('[BLOCKED APPLICATION TERMINATED]');
      if (!isRestrictedClosure) {
        latestActiveIdx = k;
        break;
      }
    }

    for (let j = 0; j < devEvents.length; j++) {
      const cur = devEvents[j];
      const title = (cur.window_title_sanitized || '');
      const isRestrictedClosure = title.includes('[RESTRICTED WEBSITE TAB CLOSED]') || title.includes('[BLOCKED APPLICATION TERMINATED]');

      if (isRestrictedClosure) {
        // Point-in-time policy enforcement event; strictly never active now
        cur.isCurrentActive = false;
        continue;
      }

      const isLiveActiveCandidate = (j === latestActiveIdx);

      if (!isLiveActiveCandidate) {
        // Find next non-restricted event to calibrate elapsed time
        let nextNonRestricted: any = null;
        for (let k = j + 1; k < devEvents.length; k++) {
          const nextTitle = (devEvents[k].window_title_sanitized || '');
          if (!nextTitle.includes('[RESTRICTED WEBSITE TAB CLOSED]') && !nextTitle.includes('[BLOCKED APPLICATION TERMINATED]')) {
            nextNonRestricted = devEvents[k];
            break;
          }
        }

        if (nextNonRestricted) {
          const curStartMs = new Date(cur.start_time).getTime();
          const nextStartMs = new Date(nextNonRestricted.start_time).getTime();
          const elapsedToNextApp = Math.max(1, Math.round((nextStartMs - curStartMs) / 1000));

          // Calibrate end time to next app's start time if normal session gap (< 4 hours)
          if (elapsedToNextApp < 14400 && elapsedToNextApp >= cur.duration_seconds) {
            cur.end_time = nextNonRestricted.start_time;
            cur.duration_seconds = elapsedToNextApp;
          }
        }
        cur.isCurrentActive = false;
      } else {
        // This is the latest genuine active window for this device!
        const todayStr = new Date().toISOString().substring(0, 10);
        const isViewingToday = (date === todayStr);
        const isOnline = cur.device_last_seen_at && cur.device_last_seen_at >= onlineCutoff;
        const curStartMs = new Date(cur.start_time).getTime();
        const eventAgeMs = now - curStartMs;

        if (isViewingToday && isOnline && eventAgeMs < 28800000) {
          const liveSecs = Math.max(1, Math.round(eventAgeMs / 1000));
          cur.end_time = new Date(now).toISOString();
          cur.duration_seconds = liveSecs;
          cur.isCurrentActive = true;
        } else {
          cur.isCurrentActive = false;
        }
      }
    }
  }

  // Sort all events by start_time ascending
  consolidated.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  // Reverse so newest session appears at the top, respecting the limit
  const activities = consolidated.reverse().slice(0, limit).map((r) => {
    const isTrulyLocked = (r.process_name || '').toLowerCase() === 'lockapp.exe' || 
                          (r.process_name || '').toLowerCase() === 'logonui.exe' || 
                          (r.window_title_sanitized || '').toLowerCase().includes('lock screen');

    let displayAppName = r.app_name || r.process_name;
    let displayTitle = r.window_title_sanitized;

    if (displayAppName === 'System Idle / Lock Screen' || displayAppName === 'system.exe') {
      if (isTrulyLocked) {
        displayAppName = 'Windows Lock Screen';
        displayTitle = 'Windows Lock Screen';
      } else {
        displayAppName = 'Idle / Away';
        displayTitle = 'Idle (No Input Activity)';
      }
    }

    return {
      id: r.id,
      deviceId: r.device_id,
      deviceName: r.device_name || r.device_identifier || 'Unknown Device',
      deviceIdentifier: r.device_identifier || '',
      employeeId: r.employee_id,
      employeeName: r.employee_name || 'Unassigned',
      employeeCode: r.emp_code || '',
      startTime: r.start_time,
      endTime: r.end_time,
      durationSeconds: Math.max(1, r.duration_seconds),
      appName: displayAppName,
      processName: isTrulyLocked ? 'lockapp.exe' : r.process_name,
      windowTitle: displayTitle,
      domain: r.domain,
      isIdle: r.is_idle === 1,
      categoryId: r.category_id,
      categoryName: r.is_idle === 1 ? (isTrulyLocked ? 'Lock Screen' : 'Idle / Away') : r.category_name,
      categoryColor: r.is_idle === 1 ? '#f59e0b' : r.category_color,
      isWork: r.is_idle === 1 ? false : r.is_work === 1,
      isCurrentActive: Boolean(r.isCurrentActive)
    };
  });

  // 3. Compute accurate full-day audited summary matching Reports & Export
  const daySummary = {
    totalInteractions: 0,
    workSeconds: 0,
    nonWorkSeconds: 0,
    idleSeconds: 0
  };

  try {
    const todayStr = new Date().toISOString().substring(0, 10);
    if (date === todayStr) {
      try {
        let refreshPairsQuery = `
          SELECT DISTINCT employee_id, device_id 
          FROM activity_events 
          WHERE (start_time >= ? AND start_time <= ?) AND employee_id != 'emp-unassigned'
        `;
        const refreshParams: any[] = [startIso, endIso];
        if (deviceId) {
          refreshPairsQuery += ` AND device_id = ?`;
          refreshParams.push(deviceId);
        }
        if (employeeId) {
          refreshPairsQuery += ` AND employee_id = ?`;
          refreshParams.push(employeeId);
        }
        const pairs = db.prepare(refreshPairsQuery).all(...refreshParams) as Array<{ employee_id: string; device_id: string }>;
        for (const p of pairs) {
          updateDailySummary(p.employee_id, p.device_id, date);
        }
      } catch (e) {}
    }

    // Query daily_summaries for audited metrics
    let dsQuery = `
      SELECT 
        COALESCE(SUM(work_time_seconds), 0) as work_seconds,
        COALESCE(SUM(non_work_time_seconds), 0) as non_work_seconds,
        COALESCE(SUM(idle_time_seconds), 0) as idle_seconds
      FROM daily_summaries
      WHERE date = ? AND employee_id != 'emp-unassigned'
    `;
    const dsParams: any[] = [date];
    if (deviceId) {
      dsQuery += ` AND device_id = ?`;
      dsParams.push(deviceId);
    }
    if (employeeId) {
      dsQuery += ` AND employee_id = ?`;
      dsParams.push(employeeId);
    }
    let dsRow = db.prepare(dsQuery).get(...dsParams) as any;

    // Count true total events for this day
    let countQuery = `
      SELECT COUNT(*) as total_events
      FROM activity_events
      WHERE (start_time >= ? AND start_time <= ?)
    `;
    const countParams: any[] = [startIso, endIso];
    if (deviceId) {
      countQuery += ` AND device_id = ?`;
      countParams.push(deviceId);
    }
    if (employeeId) {
      countQuery += ` AND employee_id = ?`;
      countParams.push(employeeId);
    }
    const countRow = db.prepare(countQuery).get(...countParams) as any;

    // If summary row is missing but events exist, populate summary
    if ((!dsRow || Number(dsRow.work_seconds) === 0) && countRow && Number(countRow.total_events) > 0) {
      try {
        let popPairsQuery = `
          SELECT DISTINCT employee_id, device_id 
          FROM activity_events 
          WHERE (start_time >= ? AND start_time <= ?) AND employee_id != 'emp-unassigned'
        `;
        const popParams: any[] = [startIso, endIso];
        if (deviceId) {
          popPairsQuery += ` AND device_id = ?`;
          popParams.push(deviceId);
        }
        if (employeeId) {
          popPairsQuery += ` AND employee_id = ?`;
          popParams.push(employeeId);
        }
        const pairs = db.prepare(popPairsQuery).all(...popParams) as Array<{ employee_id: string; device_id: string }>;
        for (const p of pairs) {
          updateDailySummary(p.employee_id, p.device_id, date);
        }
        dsRow = db.prepare(dsQuery).get(...dsParams) as any;
      } catch (e) {}
    }

    if (dsRow) {
      daySummary.workSeconds = Number(dsRow.work_seconds) || 0;
      daySummary.nonWorkSeconds = Number(dsRow.non_work_seconds) || 0;
      daySummary.idleSeconds = Number(dsRow.idle_seconds) || 0;
    }
    if (countRow) {
      daySummary.totalInteractions = Number(countRow.total_events) || 0;
    }
  } catch (err) {
    console.error('Failed to compute feed daySummary:', err);
  }

  return res.json({
    date,
    totalCount: daySummary.totalInteractions || activities.length,
    daySummary,
    currentActiveWindows,
    activities
  });
});
