import { db } from '../db/database.js';

export interface CategoryResult {
  categoryId: string;
  categoryName: string;
  isWork: boolean;
  color: string;
}

export interface ScheduleCheckResult {
  isWorkingHours: boolean;
  scheduleName: string;
}

// In-memory cache for fast categorization during high-throughput ingestion
let cachedRules: Array<{
  category_id: string;
  match_type: string;
  pattern: string;
  priority: number;
}> = [];

let cachedCategories: Map<string, { id: string; name: string; is_work: number; color: string }> = new Map();

export function refreshCategoryCache() {
  const cats = db.prepare('SELECT id, name, is_work, color FROM categories').all() as Array<{
    id: string;
    name: string;
    is_work: number;
    color: string;
  }>;
  cachedCategories.clear();
  for (const c of cats) {
    cachedCategories.set(c.id, c);
  }

  cachedRules = db.prepare(`
    SELECT category_id, match_type, pattern, priority 
    FROM category_rules 
    ORDER BY priority DESC
  `).all() as Array<{
    category_id: string;
    match_type: string;
    pattern: string;
    priority: number;
  }>;
}

// Initial load
refreshCategoryCache();

export function categorizeEvent(
  processName: string,
  domain: string | null | undefined,
  windowTitle?: string | null
): CategoryResult {
  if (cachedCategories.size === 0) {
    refreshCategoryCache();
  }

  const cleanDomain = domain ? domain.toLowerCase().trim() : '';
  const cleanProc = processName ? processName.toLowerCase().trim() : '';
  const cleanTitle = windowTitle ? windowTitle.toLowerCase().trim() : '';

  // 1. YouTube explicit check
  if (cleanDomain.includes('youtube.com') || cleanDomain.includes('youtu.be')) {
    const ytCat = cachedCategories.get('cat-youtube');
    if (ytCat) {
      return { categoryId: ytCat.id, categoryName: ytCat.name, isWork: false, color: ytCat.color };
    }
  }

  // 2. Match rules by priority
  for (const rule of cachedRules) {
    const pat = rule.pattern.toLowerCase().trim();

    if (rule.match_type === 'domain' && cleanDomain) {
      if (cleanDomain === pat || cleanDomain.endsWith('.' + pat)) {
        const cat = cachedCategories.get(rule.category_id);
        if (cat) return { categoryId: cat.id, categoryName: cat.name, isWork: cat.is_work === 1, color: cat.color };
      }
    } else if (rule.match_type === 'process' && cleanProc) {
      if (cleanProc === pat || cleanProc.includes(pat)) {
        const cat = cachedCategories.get(rule.category_id);
        if (cat) return { categoryId: cat.id, categoryName: cat.name, isWork: cat.is_work === 1, color: cat.color };
      }
    } else if (rule.match_type === 'keyword' && cleanTitle) {
      if (cleanTitle.includes(pat)) {
        const cat = cachedCategories.get(rule.category_id);
        if (cat) return { categoryId: cat.id, categoryName: cat.name, isWork: cat.is_work === 1, color: cat.color };
      }
    }
  }

  // 3. Common work browsers (Chrome, Edge, Firefox) when no non-work domain matched
  const isBrowser = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe'].includes(cleanProc);
  if (isBrowser) {
    const workCat = cachedCategories.get('cat-work') || {
      id: 'cat-work',
      name: 'Work',
      is_work: 1,
      color: '#0ea5e9'
    };
    return {
      categoryId: workCat.id,
      categoryName: workCat.name,
      isWork: true,
      color: workCat.color
    };
  }

  // 4. Lock screen or idle system processes
  if (cleanProc === 'system.exe' || cleanProc === 'lockapp.exe' || cleanTitle.includes('lock screen')) {
    return {
      categoryId: 'cat-other',
      categoryName: 'Idle / Lock Screen',
      isWork: false,
      color: '#94a3b8'
    };
  }

  // Default fallback: Other
  const otherCat = cachedCategories.get('cat-other') || {
    id: 'cat-other',
    name: 'Other',
    is_work: 0,
    color: '#6b7280'
  };

  return {
    categoryId: otherCat.id,
    categoryName: otherCat.name,
    isWork: otherCat.is_work === 1,
    color: otherCat.color
  };
}

export function checkWorkingHours(isoTimestamp: string, scheduleId?: string): ScheduleCheckResult {
  const stmt = scheduleId
    ? db.prepare('SELECT * FROM work_schedules WHERE id = ? LIMIT 1')
    : db.prepare('SELECT * FROM work_schedules WHERE is_default = 1 LIMIT 1');

  const schedule = (scheduleId ? stmt.get(scheduleId) : stmt.get()) as {
    name: string;
    work_start_time: string; // e.g. "09:30"
    work_end_time: string;   // e.g. "18:30"
    work_days: string;       // e.g. "1,2,3,4,5"
    break_start_time?: string;
    break_end_time?: string;
    timezone?: string;
  } | undefined;

  if (!schedule) {
    return { isWorkingHours: true, scheduleName: 'Standard Default' };
  }

  const date = new Date(isoTimestamp);
  const dayOfWeek = date.getUTCDay(); // 0 = Sun, 1 = Mon ... 6 = Sat
  const activeDays = schedule.work_days.split(',').map((d) => parseInt(d.trim(), 10));

  if (!activeDays.includes(dayOfWeek)) {
    return { isWorkingHours: false, scheduleName: schedule.name };
  }

  // Convert time to minutes since midnight
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const currentMinutes = hours * 60 + minutes;

  const [startH, startM] = schedule.work_start_time.split(':').map((v) => parseInt(v, 10));
  const [endH, endM] = schedule.work_end_time.split(':').map((v) => parseInt(v, 10));

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  let inHours = currentMinutes >= startMinutes && currentMinutes <= endMinutes;

  // Check if inside break period (e.g. lunch break)
  if (inHours && schedule.break_start_time && schedule.break_end_time) {
    const [bStartH, bStartM] = schedule.break_start_time.split(':').map((v) => parseInt(v, 10));
    const [bEndH, bEndM] = schedule.break_end_time.split(':').map((v) => parseInt(v, 10));
    const breakStartMinutes = bStartH * 60 + bStartM;
    const breakEndMinutes = bEndH * 60 + bEndM;
    if (currentMinutes >= breakStartMinutes && currentMinutes < breakEndMinutes) {
      // During break time, it's considered off-duty / non-working hours
      inHours = false;
    }
  }

  return { isWorkingHours: inHours, scheduleName: schedule.name };
}
