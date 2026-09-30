import { Request } from 'express';
import { db } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedAdminRequest } from './auth.js';

export function logAuditAction(
  req: AuthenticatedAdminRequest,
  action: string,
  targetEntity: string,
  targetId?: string | null,
  details?: Record<string, any>
) {
  try {
    const adminId = req.admin?.id || null;
    const adminEmail = req.admin?.email || 'system@enterprise.internal';
    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

    const insert = db.prepare(`
      INSERT INTO audit_logs (
        id, admin_id, admin_email, action, target_entity, target_id, ip_address, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      uuidv4(),
      adminId,
      adminEmail,
      action,
      targetEntity,
      targetId || null,
      ipAddress,
      details ? JSON.stringify(details) : null,
      new Date().toISOString()
    );
  } catch (err) {
    console.error('Failed to record audit log:', err);
  }
}
