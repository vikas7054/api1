/**
 * Session API Routes
 * Extracted from the custom analytics router (customRoutes.js)
 * Contains ONLY the session-related endpoints:
 *   POST   /:projectId/session          - save a single session
 *   GET    /:projectId/sessions         - list sessions for a project
 *   POST   /:projectId/sessions/batch   - save multiple sessions at once
 *
 * Mount this router the same way as the custom router, e.g.:
 *   import sessionRouter, { setSessionPool } from './session.js';
 *   setSessionPool(pool); // pass your existing mysql2 pool in
 *   app.use('/api/custom', sessionRouter);
 *
 * NOTE: This file does NOT create its own fallback DB pool on purpose.
 * The original customRoutes.js creates a fallback pool at load time; if this
 * file did the same, you'd end up with two separate pools connected to the
 * same database (double connections, double connection-limit usage).
 * Instead, call setSessionPool(pool) once from server.js / customRoutes.js
 * with the pool you already have. If you actually want this file to be
 * fully standalone with its own fallback pool, let me know and I'll add it.
 */

import express from 'express';

const sessionRouter = express.Router();

// Pool reference — must be injected via setSessionPool()
let pool = null;

// Exportable setter so server.js / customRoutes.js can hand over the pool instance
export function setSessionPool(mysqlPool) {
  pool = mysqlPool;
}

// Helper to extract real IP from request (same logic as customRoutes.js)
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(ip => ip.trim());
    return ips[0] || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
  }
  return req.headers['x-real-ip'] || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

// ============ SAVE SINGLE SESSION ============

sessionRouter.post('/:projectId/session', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const ip = getClientIp(req);
    const timestamp = new Date().toISOString();
    const recordedAt = timestamp.replace(/[:.]/g, '-');

    const { meta, ...sessionData } = req.body;
    const fullSessionData = {
      ...sessionData,
      projectId,
      ip,
      timestamp,
      recordedAt,
      recordedVia: 'custom',
      meta: meta || {}
    };

    await pool.execute(
      'INSERT INTO sessions (project_id, session_data, timestamp, recorded_at) VALUES (?, ?, ?, ?)',
      [projectId, JSON.stringify(fullSessionData), new Date(), recordedAt]
    );
    res.status(200).json({ success: true, recorded: true });
  } catch (error) {
    console.error('Session API: Session save error:', error.message);
    res.status(500).json({ error: 'Failed to save session', details: error.message });
  }
});

// ============ LIST SESSIONS ============

sessionRouter.get('/:projectId/sessions', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const [rows] = await pool.execute(
      'SELECT session_data FROM sessions WHERE project_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
      [projectId, limit, offset]
    );
    const sessions = rows.map(r => typeof r.session_data === 'string' ? JSON.parse(r.session_data) : r.session_data);
    res.json({ sessions, limit, offset, count: sessions.length });
  } catch (error) {
    console.error('Session API: Sessions fetch error:', error.message);
    res.status(500).json({ error: 'Failed to read sessions', details: error.message });
  }
});

// ============ SESSION BATCH ============

sessionRouter.post('/:projectId/sessions/batch', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const { sessions: sessionBatch } = req.body;

    if (!Array.isArray(sessionBatch) || sessionBatch.length === 0) {
      return res.status(400).json({ error: 'sessions array is required' });
    }

    const ip = getClientIp(req);
    const timestamp = new Date().toISOString();
    const recordedAt = timestamp.replace(/[:.]/g, '-');

    const values = sessionBatch.map(session => {
      const sessionData = {
        ...session,
        projectId,
        ip,
        timestamp,
        recordedAt,
        recordedVia: 'custom-batch'
      };
      return [projectId, JSON.stringify(sessionData), new Date(), recordedAt];
    });

    await pool.query(
      'INSERT INTO sessions (project_id, session_data, timestamp, recorded_at) VALUES ?',
      [values]
    );

    res.status(200).json({ success: true, recorded: sessionBatch.length });
  } catch (error) {
    console.error('Session API: Batch session error:', error.message);
    res.status(500).json({ error: 'Failed to save sessions batch', details: error.message });
  }
});

export default sessionRouter;
