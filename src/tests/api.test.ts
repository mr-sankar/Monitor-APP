import { describe, it } from 'node:test';
import assert from 'node:assert';
import { categorizeEvent, checkWorkingHours } from '../services/categorizer.js';
import { db, initDatabase } from '../db/database.js';
import { seedDatabase } from '../db/seed.js';

describe('Office Productivity Monitoring Suite Tests', () => {
  it('initializes and seeds database correctly', () => {
    initDatabase();
    seedDatabase();

    const empCount = db.prepare('SELECT COUNT(*) as count FROM employees').get() as { count: number };
    assert.ok(empCount.count >= 4, 'Should have at least 4 employees');

    const devCount = db.prepare('SELECT COUNT(*) as count FROM devices').get() as { count: number };
    assert.ok(devCount.count >= 4, 'Should have at least 4 devices');
  });

  it('categorizes processes and domains accurately without leaking privacy', () => {
    // 1. YouTube streaming
    const ytCat = categorizeEvent('chrome.exe', 'youtube.com');
    assert.strictEqual(ytCat.categoryName, 'YouTube');
    assert.strictEqual(ytCat.isWork, false);

    // 2. Development tooling
    const devCat = categorizeEvent('code.exe', null);
    assert.strictEqual(devCat.categoryName, 'Development');
    assert.strictEqual(devCat.isWork, true);

    // 3. GitHub repository
    const ghCat = categorizeEvent('msedge.exe', 'github.com');
    assert.strictEqual(ghCat.categoryName, 'Development');
    assert.strictEqual(ghCat.isWork, true);

    // 4. Communication
    const slackCat = categorizeEvent('slack.exe', null);
    assert.strictEqual(slackCat.categoryName, 'Communication');
    assert.strictEqual(slackCat.isWork, true);

    // 5. Social media
    const redditCat = categorizeEvent('chrome.exe', 'reddit.com');
    assert.strictEqual(redditCat.categoryName, 'Social Media');
    assert.strictEqual(redditCat.isWork, false);
  });

  it('checks working hours against schedule (09:30 - 18:30)', () => {
    // 2026-09-11 is a Friday (day 5)
    // 10:30 UTC -> inside working hours
    const resWorking = checkWorkingHours('2026-09-11T10:30:00Z');
    assert.strictEqual(resWorking.isWorkingHours, true);

    // 20:30 UTC -> outside working hours
    const resAfterHours = checkWorkingHours('2026-09-11T20:30:00Z');
    assert.strictEqual(resAfterHours.isWorkingHours, false);

    // Lunch break 13:30 -> outside working hours
    const resBreak = checkWorkingHours('2026-09-11T13:30:00Z');
    assert.strictEqual(resBreak.isWorkingHours, false);
  });

  it('ensures EMP-1042 prompt requirements are accurately seeded and calculated', () => {
    const summary = db.prepare(`
      SELECT * FROM daily_summaries 
      WHERE employee_id = 'emp-1042' AND date = '2026-09-11'
    `).get() as any;

    assert.ok(summary, 'EMP-1042 summary for 2026-09-11 must exist');
    assert.strictEqual(summary.youtube_seconds, 2280, 'YouTube must be 38m (2280s)');
    assert.strictEqual(summary.idle_time_seconds, 1800, 'Idle time must be 30m (1800s)');
    assert.strictEqual(summary.social_media_seconds, 1320, 'Social media must be 22m (1320s)');

    // Alerts check
    const alert = db.prepare(`
      SELECT * FROM alerts WHERE employee_id = 'emp-1042' AND alert_rule_id = 'ar-youtube'
    `).get() as any;

    assert.ok(alert, 'YouTube alert must be triggered for EMP-1042 exceeding 30m');
    assert.strictEqual(alert.severity, 'high');
  });
});
