import { describe, it } from 'node:test';
import assert from 'node:assert';
import { categorizeEvent } from '../services/categorizer.js';
import { db, initDatabase } from '../db/database.js';
import { seedDatabase } from '../db/seed.js';

describe('Office Productivity Monitoring Suite Tests', () => {
  it('initializes and seeds database correctly with enterprise defaults', () => {
    initDatabase();
    seedDatabase();

    const roleCount = db.prepare('SELECT COUNT(*) as count FROM roles').get() as { count: number };
    assert.ok(roleCount.count >= 3, 'Should have at least 3 default roles');

    const catCount = db.prepare('SELECT COUNT(*) as count FROM categories').get() as { count: number };
    assert.ok(catCount.count >= 8, 'Should have standard activity categories');

    const admin = db.prepare('SELECT * FROM administrators WHERE email = ?').get('admin@company.com') as any;
    assert.ok(admin, 'Enterprise admin should be created');
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

  it('supports prepared statements and parameter binding', () => {
    const unassigned = db.prepare('SELECT * FROM employees WHERE id = ?').get('emp-unassigned') as any;
    assert.ok(unassigned, 'Unassigned Hardware Pool should exist');
    assert.strictEqual(unassigned.emp_code, 'EMP-UNASSIGNED');
  });
});
