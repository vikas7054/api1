/**
 * Custom Analytics - Session API Routes
 * Routes mounted under /api/custom/
 */

import express from 'express';
import mysql from 'mysql2/promise';

const sessionsRouter = express.Router();

let pool = null;

// Helper to extract real IP from request
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(ip => ip.trim());
    return ips[0] || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
  }
  return req.headers['x-real-ip'] || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

// Exportable setter function for server.js / custom.js to pass its pool instance
export function setSessionsPool(mysqlPool) {
  pool = mysqlPool;
}

// Fallback configuration block
try {
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    port: Number(process.env.DB_PORT) || 4000,
    user: process.env.DB_USERNAME || '3ChjQ4FcUDcf77m.root',
    password: process.env.DB_PASSWORD || 'xOdRVKiNEHvB5ZZL',
    database: process.env.DB_DATABASE || 'test',
    ssl: { rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 10,
  });
} catch (err) {
  console.error('Sessions API: Standalone fallback database connection failed:', err.message);
}

// ============ SINGLE SESSION TRACKING ============

sessionsRouter.post('/:projectId/session', async (req, res) => {
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
    console.error('Sessions API: Session save error:', error.message);
    res.status(500).json({ error: 'Failed to save session', details: error.message });
  }
});

// ============ FETCH SESSIONS LIST (OPTIMIZED: METADATA ONLY) ============

sessionsRouter.get('/:projectId/sessions', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    // Uses TiDB JSON extraction to strictly avoid transferring heavy events arrays in list views
    const [rows] = await pool.execute(
      `SELECT 
        JSON_UNQUOTE(JSON_EXTRACT(session_data, '$.sessionId')) as sessionId,
        JSON_UNQUOTE(JSON_EXTRACT(session_data, '$.visitorId')) as visitorId,
        JSON_UNQUOTE(JSON_EXTRACT(session_data, '$.timestamp')) as timestamp,
        JSON_UNQUOTE(JSON_EXTRACT(session_data, '$.url')) as url,
        JSON_UNQUOTE(JSON_EXTRACT(session_data, '$.userAgent')) as userAgent,
        JSON_UNQUOTE(JSON_EXTRACT(session_data, '$.screenResolution')) as screenResolution,
        JSON_UNQUOTE(JSON_EXTRACT(session_data, '$.ip')) as ip,
        JSON_LENGTH(JSON_EXTRACT(session_data, '$.events')) as eventCount
       FROM sessions 
       WHERE project_id = ? 
       ORDER BY timestamp DESC 
       LIMIT ? OFFSET ?`,
      [projectId, limit, offset]
    );

    res.json({ sessions: rows, limit, offset, count: rows.length });
  } catch (error) {
    console.error('Sessions API: Sessions fetch error:', error.message);
    res.status(500).json({ error: 'Failed to read sessions', details: error.message });
  }
});

// ============ FETCH SINGLE SESSION (FULL DETAILS & EVENTS FOR PLAYER) ============

sessionsRouter.get('/:projectId/sessions/:sessionId', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId, sessionId } = req.params;

    const [rows] = await pool.execute(
      `SELECT session_data FROM sessions 
       WHERE project_id = ? AND JSON_EXTRACT(session_data, '$.sessionId') = ? 
       LIMIT 1`,
      [projectId, sessionId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = typeof rows[0].session_data === 'string' 
      ? JSON.parse(rows[0].session_data) 
      : rows[0].session_data;

    res.json({ session });
  } catch (error) {
    console.error('Sessions API: Single session fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch session details', details: error.message });
  }
});

// ============ DELETE SINGLE SESSION ============

sessionsRouter.delete('/:projectId/sessions/:sessionId', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId, sessionId } = req.params;

    const [result] = await pool.execute(
      `DELETE FROM sessions WHERE project_id = ? AND JSON_EXTRACT(session_data, '$.sessionId') = ?`,
      [projectId, sessionId]
    );

    res.json({ success: true, deleted: result.affectedRows });
  } catch (error) {
    console.error('Sessions API: Delete session error:', error.message);
    res.status(500).json({ error: 'Failed to delete session', details: error.message });
  }
});

// ============ SESSION BATCH ENDPOINT ============

sessionsRouter.post('/:projectId/sessions/batch', async (req, res) => {
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
    console.error('Sessions API: Batch session error:', error.message);
    res.status(500).json({ error: 'Failed to save sessions batch', details: error.message });
  }
});

export default sessionsRouter;
