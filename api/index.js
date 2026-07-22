import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import mysql from 'mysql2/promise';
import customRouter, { setCustomPool } from './custom.js';   // 👈 add this
import usageRouter, { setUsagePool, initUsageDatabase } from './usage.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '500mb' }));

// ============ TIDB CONNECTION ============

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

async function initDatabase() {
  const conn = await pool.getConnection();
  try {
    // 1. Projects Table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        domain VARCHAR(255) DEFAULT '',
        tracking_id VARCHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // 2. Events Table (Replaces local events filesystem files)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        project_id VARCHAR(36) NULL,
        event_data JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. Sessions Table (Replaces local sessions filesystem files)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        project_id VARCHAR(36) NULL,
        session_data JSON NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        recorded_at VARCHAR(255) NOT NULL
      )
    `);

    // 4. User Plans Table (tracks per-user plan and billing cycle)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_plans (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        plan VARCHAR(20) NOT NULL DEFAULT 'free',
        billing_cycle_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        billing_cycle_end TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_id (user_id)
      )
    `);

    // 5. Tracking Scripts Table (custom per-project tracking script)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS tracking_scripts (
        project_id VARCHAR(36) PRIMARY KEY,
        script_content LONGTEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('TiDB: All database tables verified and ready');
  } finally {
    conn.release();
  }
}

// ============ VERCEL SERVERLESS ENGINES INITIALIZATION ============

let isDbInitialized = false;
app.use(async (req, res, next) => {
  if (!isDbInitialized) {
    try {
      await initDatabase();
      isDbInitialized = true;
    } catch (err) {
      console.error('WARN: TiDB initialization error:', err.message);
    }
  }
  next();
});

// ============ GLOBAL EVENTS & SESSIONS ============

// Helper to extract real IP from request
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(ip => ip.trim());
    return ips[0] || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
  }
  return req.headers['x-real-ip'] || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

app.post('/api/events/track', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const event = { ...req.body, ip };
    await pool.execute(
      'INSERT INTO events (project_id, event_data) VALUES (NULL, ?)',
      [JSON.stringify(event)]
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save event', details: error.message });
  }
});

app.post('/api/session', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const timestamp = new Date().toISOString();
    const recordedAt = timestamp.replace(/[:.]/g, '-');
    const sessionData = { ...req.body, ip, timestamp, recordedAt };

    await pool.execute(
      'INSERT INTO sessions (project_id, session_data, timestamp, recorded_at) VALUES (NULL, ?, ?, ?)',
      [JSON.stringify(sessionData), new Date(), recordedAt]
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save session', details: error.message });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT event_data FROM events WHERE project_id IS NULL ORDER BY created_at DESC');
    const events = rows.map(r => typeof r.event_data === 'string' ? JSON.parse(r.event_data) : r.event_data);
    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read events', details: error.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT session_data FROM sessions WHERE project_id IS NULL ORDER BY timestamp DESC');
    const sessions = rows.map(r => typeof r.session_data === 'string' ? JSON.parse(r.session_data) : r.session_data);
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read sessions', details: error.message });
  }
});

// ============ PROJECT MANAGEMENT — TiDB ============

function generateTrackingId() {
  return crypto.randomBytes(12).toString('hex');
}

function rowToProject(r) {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    domain: r.domain,
    trackingId: r.tracking_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

app.get('/api/projects', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const [rows] = await pool.execute(
      'SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    res.json({ projects: rows.map(rowToProject) });
  } catch (error) {
    console.error('Error reading projects:', error);
    res.status(500).json({ error: 'Failed to read projects', details: error.message });
  }
});

app.get('/api/projects/tracking/:trackingId', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM projects WHERE tracking_id = ?',
      [req.params.trackingId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json(rowToProject(rows[0]));
  } catch (error) {
    res.status(500).json({ error: 'Failed to read project', details: error.message });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    const [rows] = await pool.execute(
      'SELECT * FROM projects WHERE id = ? AND user_id = ?',
      [req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json(rowToProject(rows[0]));
  } catch (error) {
    res.status(500).json({ error: 'Failed to read project', details: error.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name, domain, userId } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required' });
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const project = {
      id: crypto.randomUUID(),
      userId,
      name: name.trim(),
      domain: domain ? domain.trim() : '',
      trackingId: generateTrackingId(),
      createdAt: new Date().toISOString(),
    };

    await pool.execute(
      'INSERT INTO projects (id, user_id, name, domain, tracking_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [project.id, project.userId, project.name, project.domain, project.trackingId, project.createdAt]
    );

    res.status(201).json(project);
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project', details: error.message });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, domain, userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const [rows] = await pool.execute(
      'SELECT * FROM projects WHERE id = ? AND user_id = ?', [id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });

    const existing = rows[0];
    const updatedName = name ? name.trim() : existing.name;
    const updatedDomain = domain !== undefined ? domain.trim() : existing.domain;

    await pool.execute(
      'UPDATE projects SET name = ?, domain = ? WHERE id = ? AND user_id = ?',
      [updatedName, updatedDomain, id, userId]
    );

    res.json({ ...rowToProject(existing), name: updatedName, domain: updatedDomain, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: 'Failed to update project', details: error.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const [rows] = await pool.execute(
      'SELECT id FROM projects WHERE id = ? AND user_id = ?', [id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });

    await pool.execute('DELETE FROM projects WHERE id = ? AND user_id = ?', [id, userId]);

    // Wipe matching event/session data linked to this deleted project
    await pool.execute('DELETE FROM events WHERE project_id = ?', [id]);
    await pool.execute('DELETE FROM sessions WHERE project_id = ?', [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project', details: error.message });
  }
});

// ============ PROJECT-SCOPED EVENTS ============

app.post('/api/:projectId/events/track', async (req, res) => {
  try {
    const { projectId } = req.params;
    const ip = getClientIp(req);
    const eventData = { ...req.body, projectId, ip };

    await pool.execute(
      'INSERT INTO events (project_id, event_data) VALUES (?, ?)',
      [projectId, JSON.stringify(eventData)]
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save event', details: error.message });
  }
});

app.get('/api/:projectId/events', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT event_data FROM events WHERE project_id = ? ORDER BY created_at DESC',
      [req.params.projectId]
    );
    const events = rows.map(r => typeof r.event_data === 'string' ? JSON.parse(r.event_data) : r.event_data);
    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read events', details: error.message });
  }
});

// ============ PROJECT-SCOPED SESSIONS ============

app.post('/api/:projectId/session', async (req, res) => {
  try {
    const { projectId } = req.params;
    const ip = getClientIp(req);
    const timestamp = new Date().toISOString();
    const recordedAt = timestamp.replace(/[:.]/g, '-');
    const sessionData = { ...req.body, projectId, ip, timestamp, recordedAt };

    await pool.execute(
      'INSERT INTO sessions (project_id, session_data, timestamp, recorded_at) VALUES (?, ?, ?, ?)',
      [projectId, JSON.stringify(sessionData), new Date(), recordedAt]
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save session', details: error.message });
  }
});

app.get('/api/:projectId/sessions', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT session_data FROM sessions WHERE project_id = ? ORDER BY timestamp DESC',
      [req.params.projectId]
    );
    const sessions = rows.map(r => typeof r.session_data === 'string' ? JSON.parse(r.session_data) : r.session_data);
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read sessions', details: error.message });
  }
});

// ============ DELETE SINGLE SESSION ============

app.delete('/api/:projectId/sessions/:sessionId', async (req, res) => {
  try {
    const { projectId, sessionId } = req.params;

    // Delete all session chunks matching this sessionId
    const [result] = await pool.execute(
      `DELETE FROM sessions WHERE project_id = ? AND JSON_EXTRACT(session_data, '$.sessionId') = ?`,
      [projectId, sessionId]
    );

    res.json({
      success: true,
      deletedChunks: result.affectedRows
    });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session', details: error.message });
  }
});

// ============ DELETE ALL PROJECT DATA ============

app.delete('/api/:projectId/data', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Delete all events for this project
    const [eventsResult] = await pool.execute(
      'DELETE FROM events WHERE project_id = ?',
      [projectId]
    );

    // Delete all sessions for this project
    const [sessionsResult] = await pool.execute(
      'DELETE FROM sessions WHERE project_id = ?',
      [projectId]
    );

    res.json({
      success: true,
      deletedEvents: eventsResult.affectedRows,
      deletedSessions: sessionsResult.affectedRows
    });
  } catch (error) {
    console.error('Error deleting project data:', error);
    res.status(500).json({ error: 'Failed to delete project data', details: error.message });
  }
});

app.use('/api/custom', customRouter);
app.use('/api/usage', usageRouter);

export default app;
