import { db } from './database.js';

export function cleanDummyData() {
  db.exec(`
    DELETE FROM activity_events;
    DELETE FROM daily_summaries;
    DELETE FROM alerts;
    DELETE FROM device_assignments;
    DELETE FROM devices;
    DELETE FROM employees WHERE id != 'emp-unassigned';
    DELETE FROM audit_logs;
  `);

  const empCount = (db.prepare('SELECT COUNT(*) as count FROM employees').get() as any).count;
  const devCount = (db.prepare('SELECT COUNT(*) as count FROM devices').get() as any).count;
  const eventCount = (db.prepare('SELECT COUNT(*) as count FROM activity_events').get() as any).count;
  const alertCount = (db.prepare('SELECT COUNT(*) as count FROM alerts').get() as any).count;

  console.log('✅ ALL DUMMY DATA PURGED SUCCESSFULLY:');
  console.log(`   Employees remaining: ${empCount} (Hardware Staging Pool)`);
  console.log(`   Devices remaining: ${devCount}`);
  console.log(`   Activity Events: ${eventCount}`);
  console.log(`   Alerts: ${alertCount}`);
}

cleanDummyData();
