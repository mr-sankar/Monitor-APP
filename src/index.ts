import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { db, initDatabase } from './db/database.js';
import { seedDatabase } from './db/seed.js';
import { authRouter } from './routes/authRoutes.js';
import { agentRouter } from './routes/agentRoutes.js';
import { dashboardRouter } from './routes/dashboardRoutes.js';
import { employeeRouter } from './routes/employeeRoutes.js';
import { deviceRouter } from './routes/deviceRoutes.js';
import { alertRouter } from './routes/alertRoutes.js';
import { reportRouter } from './routes/reportRoutes.js';
import { settingRouter } from './routes/settingRoutes.js';
import { checkDeviceDisconnections } from './services/alertEngine.js';
import { refreshCategoryCache } from './services/categorizer.js';

dotenv.config();

// Global crash protection
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]:', reason);
});

// Initialize Database & Seeds
initDatabase();
seedDatabase();
refreshCategoryCache();

const app = express();
const PORT = process.env.PORT || 5000;

// Security & Middlewares
app.use(helmet({
  crossOriginResourcePolicy: false
}));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Device-Id',
    'X-Device-Token',
    'ngrok-skip-browser-warning',
    'Bypass-Tunnel-Reminder',
    'bypass-tunnel-reminder',
    'Accept',
    'Origin',
    'X-Requested-With'
  ]
}));
app.use(express.json({ limit: '10mb' }));

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Mount API Endpoints
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/agent', agentRouter);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/employees', employeeRouter);
app.use('/api/v1/devices', deviceRouter);
app.use('/api/v1/alerts', alertRouter);
app.use('/api/v1/reports', reportRouter);
app.use('/api/v1/settings', settingRouter);

// Serve built frontend SPA if exists
import path from 'node:path';
import fs from 'node:fs';

const frontendDist = path.resolve(process.cwd(), '../frontend/dist');
const altFrontendDist = path.resolve(process.cwd(), 'frontend/dist');
const activeDist = fs.existsSync(frontendDist) ? frontendDist : fs.existsSync(altFrontendDist) ? altFrontendDist : null;

if (activeDist) {
  app.use(express.static(activeDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/health') return next();
    res.sendFile(path.join(activeDist, 'index.html'));
  });
}

// 404 handler for API routes
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err?.message || 'Unknown error' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🏢 Office Productivity Monitoring Backend API`);
    console.log(`🌐 Server running on http://localhost:${PORT} (0.0.0.0)`);
    console.log(`🔒 Security & Privacy Filtering: ACTIVE`);
    console.log(`📡 Heartbeat Disconnection Watchdog: ACTIVE (30s interval)`);
    console.log(`=======================================================`);
  });

  // Background Watchdog: check for disconnected/stopped employee monitoring agents every 30 seconds
  setInterval(() => {
    try {
      checkDeviceDisconnections();
    } catch (err) {
      console.error('[Watchdog] Error checking device disconnections:', err);
    }
  }, 30 * 1000);

  // 90-Day Data Retention Policy: Enforce on startup and every 24 hours
  function enforceDataRetention() {
    try {
      const setting = db.prepare("SELECT value FROM system_settings WHERE key = 'data_retention_days'").get() as { value: string } | undefined;
      const days = parseInt(setting?.value || '90', 10);
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const cutoffDayStr = cutoffDate.substring(0, 10);

      db.prepare('DELETE FROM activity_events WHERE start_time < ?').run(cutoffDate);
      db.prepare('DELETE FROM daily_summaries WHERE date < ?').run(cutoffDayStr);
      db.prepare('DELETE FROM alerts WHERE triggered_at < ?').run(cutoffDate);
      db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoffDate);

      console.log(`[Retention Policy] Enforced ${days}-day retention limit. Retaining all historical logs from past ${days} days.`);
    } catch (err) {
      console.error('[Retention Policy Error]:', err);
    }
  }

  enforceDataRetention();
  setInterval(enforceDataRetention, 24 * 60 * 60 * 1000);
}

export default app;
