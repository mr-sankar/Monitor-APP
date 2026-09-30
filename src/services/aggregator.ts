import { db } from '../db/database.js';

export interface EmployeeDayMetrics {
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  department: string;
  deviceId: string;
  deviceHostname: string;
  date: string;
  totalTimeSeconds: number;
  activeTimeSeconds: number;
  idleTimeSeconds: number;
  workTimeSeconds: number;
  nonWorkTimeSeconds: number;
  youtubeSeconds: number;
  socialMediaSeconds: number;
  entertainmentSeconds: number;
  workUtilizationPercent: number;
  nonWorkPercent: number;
  categoryBreakdown: Record<string, { seconds: number; isWork: boolean; color: string }>;
  topApps: Array<{ name: string; duration_seconds: number; percentage: number }>;
  topDomains: Array<{ domain: string; duration_seconds: number; percentage: number }>;
}

export function updateDailySummary(employeeId: string, deviceId: string, targetDate: string) {
  const startIso = `${targetDate}T00:00:00.000Z`;
  const endIso = `${targetDate}T23:59:59.999Z`;

  // Aggregate all events for this employee and date
  const events = db.prepare(`
    SELECT 
      e.id, e.event_type, e.process_name, e.app_name, e.domain,
      e.duration_seconds, e.is_idle, e.is_working_hours,
      e.start_time, e.end_time,
      c.id as category_id, c.name as category_name, c.is_work, c.color
    FROM activity_events e
    JOIN categories c ON e.category_id = c.id
    WHERE e.employee_id = ? 
      AND (e.start_time >= ? AND e.start_time <= ?)
  `).all(employeeId, startIso, endIso) as Array<{
    id: string;
    event_type: string;
    process_name: string;
    app_name: string;
    domain: string | null;
    duration_seconds: number;
    is_idle: number;
    is_working_hours: number;
    start_time: string;
    end_time: string;
    category_id: string;
    category_name: string;
    is_work: number;
    color: string;
  }>;

  if (events.length === 0) return;

  // Collect intervals to compute exact, non-overlapping wall-clock durations
  const activeIntervals: Array<{ startMs: number; endMs: number }> = [];
  const idleIntervals: Array<{ startMs: number; endMs: number }> = [];
  const workIntervals: Array<{ startMs: number; endMs: number }> = [];
  const nonWorkIntervals: Array<{ startMs: number; endMs: number }> = [];
  const ytIntervals: Array<{ startMs: number; endMs: number }> = [];

  const catMap: Record<string, number> = {};
  const appMap: Record<string, number> = {};
  const domainMap: Record<string, number> = {};

  for (const ev of events) {
    const startMs = new Date(ev.start_time).getTime();
    let endMs = new Date(ev.end_time).getTime();
    if (isNaN(endMs) || endMs <= startMs) {
      endMs = startMs + Math.max(1, ev.duration_seconds) * 1000;
    }
    const trueWallDuration = Math.max(1, Math.round((endMs - startMs) / 1000));
    const dur = Math.min(ev.duration_seconds, trueWallDuration);

    const isLockOrSystem = (ev.app_name || '').toLowerCase().includes('lock screen') || (ev.process_name || '').toLowerCase() === 'system.exe';
    const isActuallyIdle = ev.is_idle === 1 || isLockOrSystem;

    if (isActuallyIdle) {
      idleIntervals.push({ startMs, endMs });
    } else {
      activeIntervals.push({ startMs, endMs });
      if (ev.is_work === 1) {
        workIntervals.push({ startMs, endMs });
      } else {
        nonWorkIntervals.push({ startMs, endMs });
      }

      const appKey = ev.app_name || ev.process_name || 'Unknown';
      appMap[appKey] = (appMap[appKey] || 0) + dur;

      if (ev.domain) {
        domainMap[ev.domain] = (domainMap[ev.domain] || 0) + dur;
      }
    }

    if (ev.category_id === 'cat-youtube' || (ev.domain && ev.domain.includes('youtube.com'))) {
      ytIntervals.push({ startMs, endMs });
    }

    const catName = isActuallyIdle ? 'Idle' : (ev.category_name || 'Other');
    catMap[catName] = (catMap[catName] || 0) + dur;
  }

  const mergeIntervals = (list: Array<{ startMs: number; endMs: number }>): number => {
    if (list.length === 0) return 0;
    list.sort((a, b) => a.startMs - b.startMs);
    let total = 0;
    let curStart = list[0].startMs;
    let curEnd = list[0].endMs;

    for (let i = 1; i < list.length; i++) {
      if (list[i].startMs <= curEnd) {
        curEnd = Math.max(curEnd, list[i].endMs);
      } else {
        total += Math.max(0, Math.round((curEnd - curStart) / 1000));
        curStart = list[i].startMs;
        curEnd = list[i].endMs;
      }
    }
    total += Math.max(0, Math.round((curEnd - curStart) / 1000));
    return total;
  };

  const activeSecs = mergeIntervals(activeIntervals);
  const idleSecs = mergeIntervals(idleIntervals);
  const workSecs = mergeIntervals(workIntervals);
  const nonWorkSecs = mergeIntervals(nonWorkIntervals);
  const youtubeSecs = mergeIntervals(ytIntervals);
  const totalSecs = activeSecs + idleSecs;
  let socialSecs = 0;
  let entSecs = 0;

  const topApps = Object.entries(appMap)
    .map(([name, duration_seconds]) => ({ name, duration_seconds }))
    .sort((a, b) => b.duration_seconds - a.duration_seconds)
    .slice(0, 10);

  const topDomains = Object.entries(domainMap)
    .map(([domain, duration_seconds]) => ({ domain, duration_seconds }))
    .sort((a, b) => b.duration_seconds - a.duration_seconds)
    .slice(0, 10);

  const nowIso = new Date().toISOString();
  const summaryId = `summary-${targetDate}-${deviceId}-${employeeId}`;

  const upsert = db.prepare(`
    INSERT INTO daily_summaries (
      id, date, device_id, employee_id, total_time_seconds,
      active_time_seconds, idle_time_seconds, work_time_seconds,
      non_work_time_seconds, youtube_seconds, social_media_seconds,
      entertainment_seconds, category_breakdown_json, top_apps_json,
      top_domains_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, device_id, employee_id) DO UPDATE SET
      total_time_seconds = excluded.total_time_seconds,
      active_time_seconds = excluded.active_time_seconds,
      idle_time_seconds = excluded.idle_time_seconds,
      work_time_seconds = excluded.work_time_seconds,
      non_work_time_seconds = excluded.non_work_time_seconds,
      youtube_seconds = excluded.youtube_seconds,
      social_media_seconds = excluded.social_media_seconds,
      entertainment_seconds = excluded.entertainment_seconds,
      category_breakdown_json = excluded.category_breakdown_json,
      top_apps_json = excluded.top_apps_json,
      top_domains_json = excluded.top_domains_json,
      updated_at = excluded.updated_at
  `);

  upsert.run(
    summaryId,
    targetDate,
    deviceId,
    employeeId,
    totalSecs,
    activeSecs,
    idleSecs,
    workSecs,
    nonWorkSecs,
    youtubeSecs,
    socialSecs,
    entSecs,
    JSON.stringify(catMap),
    JSON.stringify(topApps),
    JSON.stringify(topDomains),
    nowIso
  );
}

export function getCompanyOverview(targetDate?: string) {
  const date = targetDate || new Date().toISOString().substring(0, 10);

  // Online devices: heartbeat within last 90 seconds
  const onlineCutoff = new Date(Date.now() - 90 * 1000).toISOString();

  const deviceStats = db.prepare(`
    SELECT 
      COUNT(*) as total_devices,
      SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END) as online_devices
    FROM devices
    WHERE status = 'active'
  `).get(onlineCutoff) as { total_devices: number; online_devices: number | null };

  const startIso = `${date}T00:00:00.000Z`;
  const endIso = `${date}T23:59:59.999Z`;

  const activeEmployeesCount = db.prepare(`
    SELECT COUNT(DISTINCT employee_id) as count
    FROM activity_events
    WHERE (start_time >= ? AND start_time <= ?) AND is_idle = 0 AND employee_id != 'emp-unassigned'
  `).get(startIso, endIso) as { count: number };

  const aggregateMetrics = db.prepare(`
    SELECT 
      SUM(total_time_seconds) as total_seconds,
      SUM(active_time_seconds) as active_seconds,
      SUM(idle_time_seconds) as idle_seconds,
      SUM(work_time_seconds) as work_seconds,
      SUM(non_work_time_seconds) as non_work_seconds,
      SUM(youtube_seconds) as youtube_seconds,
      SUM(social_media_seconds) as social_seconds,
      SUM(entertainment_seconds) as ent_seconds
    FROM daily_summaries
    WHERE date = ?
  `).get(date) as {
    total_seconds: number | null;
    active_seconds: number | null;
    idle_seconds: number | null;
    work_seconds: number | null;
    non_work_seconds: number | null;
    youtube_seconds: number | null;
    social_seconds: number | null;
    ent_seconds: number | null;
  };

  const activeSecs = aggregateMetrics?.active_seconds || 0;
  const workSecs = aggregateMetrics?.work_seconds || 0;
  const nonWorkSecs = aggregateMetrics?.non_work_seconds || 0;

  const workUtilizationPercent = activeSecs > 0 ? Math.round((workSecs / activeSecs) * 100) : 0;
  const nonWorkPercent = activeSecs > 0 ? Math.round((nonWorkSecs / activeSecs) * 100) : 0;

  // Unresolved alerts count
  const alertsCount = db.prepare(`
    SELECT COUNT(*) as count FROM alerts WHERE status = 'open'
  `).get() as { count: number };

  return {
    date,
    totalDevices: deviceStats.total_devices || 0,
    onlineDevices: deviceStats.online_devices || 0,
    activeEmployees: activeEmployeesCount?.count || 0,
    totalTrackedSeconds: aggregateMetrics?.total_seconds || 0,
    activeSeconds: activeSecs,
    idleSeconds: aggregateMetrics?.idle_seconds || 0,
    workSeconds: workSecs,
    nonWorkSeconds: nonWorkSecs,
    youtubeSeconds: aggregateMetrics?.youtube_seconds || 0,
    socialMediaSeconds: aggregateMetrics?.social_seconds || 0,
    entertainmentSeconds: aggregateMetrics?.ent_seconds || 0,
    workUtilizationPercent,
    nonWorkPercent,
    openAlertsCount: alertsCount.count
  };
}

export function getEmployeeProductivity(employeeId: string, date: string): EmployeeDayMetrics | null {
  const emp = db.prepare(`
    SELECT e.id, e.emp_code, e.name, e.department, d.id as device_id, d.hostname
    FROM employees e
    LEFT JOIN device_assignments da ON da.employee_id = e.id AND da.is_active = 1
    LEFT JOIN devices d ON d.id = da.device_id
    WHERE e.id = ?
  `).get(employeeId) as {
    id: string;
    emp_code: string;
    name: string;
    department: string;
    device_id: string | null;
    hostname: string | null;
  } | undefined;

  if (!emp) return null;

  const summary = db.prepare(`
    SELECT * FROM daily_summaries WHERE employee_id = ? AND date = ?
  `).get(employeeId, date) as any;

  if (!summary) {
    return {
      employeeId: emp.id,
      employeeName: emp.name,
      employeeCode: emp.emp_code,
      department: emp.department,
      deviceId: emp.device_id || 'N/A',
      deviceHostname: emp.hostname || 'N/A',
      date,
      totalTimeSeconds: 0,
      activeTimeSeconds: 0,
      idleTimeSeconds: 0,
      workTimeSeconds: 0,
      nonWorkTimeSeconds: 0,
      youtubeSeconds: 0,
      socialMediaSeconds: 0,
      entertainmentSeconds: 0,
      workUtilizationPercent: 0,
      nonWorkPercent: 0,
      categoryBreakdown: {},
      topApps: [],
      topDomains: []
    };
  }

  const catBreakdownRaw = JSON.parse(summary.category_breakdown_json || '{}');
  const topAppsRaw = JSON.parse(summary.top_apps_json || '[]');
  const topDomainsRaw = JSON.parse(summary.top_domains_json || '[]');

  const allCats = db.prepare('SELECT id, name, is_work, color FROM categories').all() as Array<{
    id: string;
    name: string;
    is_work: number;
    color: string;
  }>;
  const catMeta = new Map(allCats.map((c) => [c.name, c]));

  const categoryBreakdown: Record<string, { seconds: number; isWork: boolean; color: string }> = {};
  for (const [cName, secs] of Object.entries(catBreakdownRaw)) {
    const meta = catMeta.get(cName);
    categoryBreakdown[cName] = {
      seconds: secs as number,
      isWork: meta ? meta.is_work === 1 : false,
      color: meta ? meta.color : '#6b7280'
    };
  }

  const activeSecs = summary.active_time_seconds || 0;
  const topApps = topAppsRaw.map((a: any) => ({
    name: a.name,
    duration_seconds: a.duration_seconds,
    percentage: activeSecs > 0 ? Math.round((a.duration_seconds / activeSecs) * 100) : 0
  }));

  const topDomains = topDomainsRaw.map((d: any) => ({
    domain: d.domain,
    duration_seconds: d.duration_seconds,
    percentage: activeSecs > 0 ? Math.round((d.duration_seconds / activeSecs) * 100) : 0
  }));

  return {
    employeeId: emp.id,
    employeeName: emp.name,
    employeeCode: emp.emp_code,
    department: emp.department,
    deviceId: emp.device_id || 'N/A',
    deviceHostname: emp.hostname || 'N/A',
    date,
    totalTimeSeconds: summary.total_time_seconds,
    activeTimeSeconds: summary.active_time_seconds,
    idleTimeSeconds: summary.idle_time_seconds,
    workTimeSeconds: summary.work_time_seconds,
    nonWorkTimeSeconds: summary.non_work_time_seconds,
    youtubeSeconds: summary.youtube_seconds,
    socialMediaSeconds: summary.social_media_seconds,
    entertainmentSeconds: summary.entertainment_seconds,
    workUtilizationPercent:
      summary.active_time_seconds > 0
        ? Math.round((summary.work_time_seconds / summary.active_time_seconds) * 100)
        : 0,
    nonWorkPercent:
      summary.active_time_seconds > 0
        ? Math.round((summary.non_work_time_seconds / summary.active_time_seconds) * 100)
        : 0,
    categoryBreakdown,
    topApps,
    topDomains
  };
}
