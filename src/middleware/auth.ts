import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../db/database.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'office-productivity-secret-key-enterprise-2026';

export interface AuthenticatedAdminRequest extends Request {
  admin?: {
    id: string;
    email: string;
    roleId: string;
    roleName: string;
    permissions: string[];
  };
}

export interface AuthenticatedDeviceRequest extends Request {
  device?: {
    id: string;
    device_identifier: string;
    employee_id: string;
  };
}

export function authenticateAdmin(req: AuthenticatedAdminRequest, res: Response, next: NextFunction) {
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query.token && typeof req.query.token === 'string') {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authorization header missing or invalid format' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      email: string;
      roleId: string;
    };

    const admin = db.prepare(`
      SELECT a.id, a.email, a.role_id, a.is_active, r.name as role_name, r.permissions_json
      FROM administrators a
      JOIN roles r ON a.role_id = r.id
      WHERE a.id = ? AND a.is_active = 1
    `).get(decoded.id) as {
      id: string;
      email: string;
      role_id: string;
      is_active: number;
      role_name: string;
      permissions_json: string;
    } | undefined;

    if (!admin) {
      return res.status(401).json({ error: 'User not found or account deactivated' });
    }

    req.admin = {
      id: admin.id,
      email: admin.email,
      roleId: admin.role_id,
      roleName: admin.role_name,
      permissions: JSON.parse(admin.permissions_json || '[]')
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedAdminRequest, res: Response, next: NextFunction) => {
    if (!req.admin) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Super Administrator wildcard bypass
    if (req.admin.permissions.includes('*')) {
      return next();
    }

    if (allowedRoles.includes(req.admin.roleId) || allowedRoles.includes(req.admin.roleName)) {
      return next();
    }

    return res.status(403).json({ error: 'Insufficient administrative privileges for this action' });
  };
}

export function authenticateDevice(req: AuthenticatedDeviceRequest, res: Response, next: NextFunction) {
  const deviceId = req.headers['x-device-id'] as string;
  const deviceToken = req.headers['x-device-token'] as string;

  if (!deviceId || !deviceToken) {
    return res.status(401).json({ error: 'Missing device credentials (X-Device-Id, X-Device-Token)' });
  }

  let dev = db.prepare(`
    SELECT d.id, d.device_identifier, d.secret_hash, d.status, da.employee_id
    FROM devices d
    LEFT JOIN device_assignments da ON da.device_id = d.id AND da.is_active = 1
    WHERE d.id = ? OR d.device_identifier = ?
  `).get(deviceId, deviceId) as {
    id: string;
    device_identifier: string;
    secret_hash: string;
    status: string;
    employee_id: string | null;
  } | undefined;

  if (!dev) {
    return res.status(401).json({ error: 'Device not recognized or unregistered by administrator' });
  }

  if (dev.status !== 'active') {
    return res.status(401).json({ error: 'Device deactivated or revoked by administrator' });
  }

  // Verify device secret token
  const matches = bcrypt.compareSync(deviceToken, dev.secret_hash);
  if (!matches) {
    return res.status(401).json({ error: 'Invalid device authentication token' });
  }

  req.device = {
    id: dev.id,
    device_identifier: dev.device_identifier,
    employee_id: dev.employee_id || 'emp-unassigned'
  };

  // Update last seen timestamp
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), dev.id);

  next();
}
