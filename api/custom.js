/**
 * Custom Analytics API Routes
 * Optimized for Option 3 tracking with efficient data handling
 * Routes mounted under /api/custom/
 */

import express from 'express';
const customRouter = express.Router();

// Helper to extract real IP from request
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(ip => ip.trim());
    return ips[0] || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
  }
  return req.headers['x-real-ip'] || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

//pool manual 
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
  port: Number(process.env.DB_PORT) || 4000,
  user: process.env.DB_USERNAME || '3ChjQ4FcUDcf77m.root',
  password: process.env.DB_PASSWORD || 'xOdRVKiNEHvB5ZZL',
  database: process.env.DB_DATABASE || 'test',
  ssl: { rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10,
});

setCustomPool(pool);   // 👈 add this, right after pool is created
// Pool is passed from server.js
let pool = null;

export function setCustomPool(mysqlPool) {
  pool = mysqlPool;
}

// ============ CUSTOM PROJECT-SCOPED EVENTS ============

customRouter.post('/:projectId/events/track', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const ip = getClientIp(req);
    const eventData = { ...req.body, projectId, ip, recordedVia: 'custom' };

    await pool.execute(
      'INSERT INTO events (project_id, event_data) VALUES (?, ?)',
      [projectId, JSON.stringify(eventData)]
    );
    res.status(200).json({ success: true, recorded: true });
  } catch (error) {
    console.error('Custom API: Event track error:', error.message);
    res.status(500).json({ error: 'Failed to save event', details: error.message });
  }
});

customRouter.get('/:projectId/events', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const [rows] = await pool.execute(
      'SELECT event_data FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [projectId, limit, offset]
    );
    const events = rows.map(r => typeof r.event_data === 'string' ? JSON.parse(r.event_data) : r.event_data);
    res.json({ events, limit, offset, count: events.length });
  } catch (error) {
    console.error('Custom API: Events fetch error:', error.message);
    res.status(500).json({ error: 'Failed to read events', details: error.message });
  }
});

// ============ CUSTOM PROJECT-SCOPED SESSIONS ============

customRouter.post('/:projectId/session', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const ip = getClientIp(req);
    const timestamp = new Date().toISOString();
    const recordedAt = timestamp.replace(/[:.]/g, '-');

    // Extract metadata if present (from optimized tracking)
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
    console.error('Custom API: Session save error:', error.message);
    res.status(500).json({ error: 'Failed to save session', details: error.message });
  }
});

customRouter.get('/:projectId/sessions', async (req, res) => {
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
    console.error('Custom API: Sessions fetch error:', error.message);
    res.status(500).json({ error: 'Failed to read sessions', details: error.message });
  }
});

// ============ SESSION BATCH ENDPOINT (for efficient bulk writes) ============

customRouter.post('/:projectId/sessions/batch', async (req, res) => {
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

    // Batch insert sessions
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

    // MySQL batch insert
    await pool.query(
      'INSERT INTO sessions (project_id, session_data, timestamp, recorded_at) VALUES ?',
      [values]
    );

    res.status(200).json({ success: true, recorded: sessionBatch.length });
  } catch (error) {
    console.error('Custom API: Batch session error:', error.message);
    res.status(500).json({ error: 'Failed to save sessions batch', details: error.message });
  }
});

// ============ EVENTS BATCH ENDPOINT ============

customRouter.post('/:projectId/events/batch', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const { events: eventBatch } = req.body;

    if (!Array.isArray(eventBatch) || eventBatch.length === 0) {
      return res.status(400).json({ error: 'events array is required' });
    }

    const ip = getClientIp(req);

    // Batch insert events
    const values = eventBatch.map(event => {
      const eventData = {
        ...event,
        projectId,
        ip,
        recordedVia: 'custom-batch'
      };
      return [projectId, JSON.stringify(eventData)];
    });

    await pool.query(
      'INSERT INTO events (project_id, event_data) VALUES ?',
      [values]
    );

    res.status(200).json({ success: true, recorded: eventBatch.length });
  } catch (error) {
    console.error('Custom API: Batch events error:', error.message);
    res.status(500).json({ error: 'Failed to save events batch', details: error.message });
  }
});

// ============ SESSION STATS ============

customRouter.get('/:projectId/stats', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;

    // Get session count
    const [sessionRows] = await pool.execute(
      'SELECT COUNT(*) as count FROM sessions WHERE project_id = ?',
      [projectId]
    );

    // Get event count
    const [eventRows] = await pool.execute(
      'SELECT COUNT(*) as count FROM events WHERE project_id = ?',
      [projectId]
    );

    // Get total session data size (approximate)
    const [sizeRows] = await pool.execute(
      'SELECT SUM(LENGTH(session_data)) as totalSize FROM sessions WHERE project_id = ?',
      [projectId]
    );

    res.json({
      projectId,
      sessions: sessionRows[0]?.count || 0,
      events: eventRows[0]?.count || 0,
      totalDataSize: sizeRows[0]?.totalSize || 0
    });
  } catch (error) {
    console.error('Custom API: Stats error:', error.message);
    res.status(500).json({ error: 'Failed to get stats', details: error.message });
  }
});

// ============ PRUNE OLD DATA ============

customRouter.delete('/:projectId/prune', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const olderThanDays = parseInt(req.query.days) || 30;

    // Calculate cutoff date
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    // Delete old sessions
    const [sessionsResult] = await pool.execute(
      'DELETE FROM sessions WHERE project_id = ? AND timestamp < ?',
      [projectId, cutoff]
    );

    // Delete old events
    const [eventsResult] = await pool.execute(
      'DELETE FROM events WHERE project_id = ? AND created_at < ?',
      [projectId, cutoff]
    );

    res.json({
      success: true,
      prunedSessions: sessionsResult.affectedRows,
      prunedEvents: eventsResult.affectedRows,
      olderThanDays
    });
  } catch (error) {
    console.error('Custom API: Prune error:', error.message);
    res.status(500).json({ error: 'Failed to prune data', details: error.message });
  }
});

export default customRouter;
