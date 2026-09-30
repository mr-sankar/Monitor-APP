import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db/database.js';
import { JWT_SECRET, authenticateAdmin, AuthenticatedAdminRequest } from '../middleware/auth.js';
import { logAuditAction } from '../middleware/audit.js';

export const authRouter = Router();

authRouter.post('/login', (req, res): Response | void => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const admin = db.prepare(`
    SELECT a.id, a.email, a.password_hash, a.full_name, a.role_id, a.is_active,
           r.name as role_name, r.permissions_json
    FROM administrators a
    JOIN roles r ON a.role_id = r.id
    WHERE LOWER(a.email) = LOWER(?)
  `).get(email) as {
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    role_id: string;
    is_active: number;
    role_name: string;
    permissions_json: string;
  } | undefined;

  if (!admin || admin.is_active !== 1) {
    return res.status(401).json({ error: 'Invalid credentials or inactive account' });
  }

  const isValid = bcrypt.compareSync(password, admin.password_hash);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Update last login
  const now = new Date().toISOString();
  db.prepare('UPDATE administrators SET last_login = ? WHERE id = ?').run(now, admin.id);

  const permissions = JSON.parse(admin.permissions_json || '[]');
  const token = jwt.sign(
    {
      id: admin.id,
      email: admin.email,
      roleId: admin.role_id,
      roleName: admin.role_name
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  const authReq = req as AuthenticatedAdminRequest;
  authReq.admin = {
    id: admin.id,
    email: admin.email,
    roleId: admin.role_id,
    roleName: admin.role_name,
    permissions
  };
  logAuditAction(authReq, 'LOGIN', 'administrators', admin.id, { email: admin.email });

  return res.json({
    token,
    user: {
      id: admin.id,
      email: admin.email,
      fullName: admin.full_name,
      roleId: admin.role_id,
      roleName: admin.role_name,
      permissions
    }
  });
});

authRouter.get('/me', authenticateAdmin, (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  if (!req.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const admin = db.prepare(`
    SELECT a.id, a.email, a.full_name, a.role_id, a.last_login,
           r.name as role_name, r.permissions_json
    FROM administrators a
    JOIN roles r ON a.role_id = r.id
    WHERE a.id = ?
  `).get(req.admin.id) as any;

  return res.json({
    id: admin.id,
    email: admin.email,
    fullName: admin.full_name,
    roleId: admin.role_id,
    roleName: admin.role_name,
    permissions: JSON.parse(admin.permissions_json || '[]'),
    lastLogin: admin.last_login
  });
});

authRouter.post('/change-password', authenticateAdmin, (req: AuthenticatedAdminRequest, res: Response): Response | void => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long' });
  }

  const admin = db.prepare('SELECT password_hash FROM administrators WHERE id = ?').get(req.admin!.id) as {
    password_hash: string;
  };

  if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
    return res.status(400).json({ error: 'Current password incorrect' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE administrators SET password_hash = ? WHERE id = ?').run(newHash, req.admin!.id);

  logAuditAction(req, 'CHANGE_PASSWORD', 'administrators', req.admin!.id);
  return res.json({ success: true, message: 'Password updated successfully' });
});
