import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============ TIDB ============

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 4000,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE || 'test',
  ssl: { rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10,
});

async function initDatabase() {
  const conn = await pool.getConnection();
  try {
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
    console.log('TiDB: projects table ready');
  } finally {
    conn.release();
  }
}

// ============ LOCAL FILE HELPERS (events/sessions only) ============

const dataDir = path.join(__dirname, 'data');
const sessionDir = path.join(dataDir, 'session');
const projectsDir = path.join(dataDir, 'projects');

async function ensureDirectories() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
}

async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.trim() ? JSON.parse(content) : null;
  } catch { return null; }
}

async function writeJsonFile(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
    return false;
  }
}

await ensureDirectories();

// Ensure data.json and events.txt exist
const jsonFile = path.join(dataDir, 'data.json');
const logFile = path.join(dataDir, 'events.txt');
try { await fs.access(jsonFile); } catch { await fs.writeFile(jsonFile, JSON.stringify({ events: [] })); }
try { await fs.access(logFile); } catch { await fs.writeFile(logFile, ''); }

// ============ GLOBAL EVENTS & SESSIONS ============

app.post('/api/events/track', async (req, res) => {
  try {
    const event = req.body;
    await fs.appendFile(logFile, JSON.stringify(event) + '\n');
    const jsonData = await readJsonFile(jsonFile) || { events: [] };
    jsonData.events.push(event);
    await writeJsonFile(jsonFile, jsonData);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save event', details: error.message });
  }
});

app.post('/api/session', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(sessionDir, `session_${timestamp}.json`);
    await writeJsonFile(filePath, { ...req.body, timestamp: new Date().toISOString(), recordedAt: timestamp });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save session', details: error.message });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    res.json(await readJsonFile(jsonFile) || { events: [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read events', details: error.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const files = await fs.readdir(sessionDir);
    const sessions = (await Promise.all(
      files.filter(f => f.endsWith('.json')).map(f => readJsonFile(path.join(sessionDir, f)))
    )).filter(Boolean);
    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
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

// GET /api/projects?userId=xxx  — list all projects for a user
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

// GET /api/projects/tracking/:trackingId  — must be before /:id
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

// GET /api/projects/:id
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

// POST /api/projects  — create project directly in TiDB
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

    console.log('Project created in TiDB:', project.id, project.name);
    res.status(201).json(project);
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project', details: error.message });
  }
});

// PUT /api/projects/:id
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

// DELETE /api/projects/:id?userId=xxx
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

    // Clean up any local event/session files for this project
    try { await fs.unlink(path.join(projectsDir, `${id}_events.json`)); } catch {}
    try { await fs.unlink(path.join(projectsDir, `${id}_sessions.json`)); } catch {}

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
    const eventsFile = path.join(projectsDir, `${projectId}_events.json`);
    const eventsData = await readJsonFile(eventsFile) || { events: [] };
    eventsData.events.push({ ...req.body, projectId });
    await writeJsonFile(eventsFile, eventsData);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save event', details: error.message });
  }
});

app.get('/api/:projectId/events', async (req, res) => {
  try {
    const eventsFile = path.join(projectsDir, `${req.params.projectId}_events.json`);
    res.json(await readJsonFile(eventsFile) || { events: [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read events', details: error.message });
  }
});

// ============ PROJECT-SCOPED SESSIONS ============

app.post('/api/:projectId/session', async (req, res) => {
  try {
    const { projectId } = req.params;
    const projectSessionDir = path.join(projectsDir, projectId, 'sessions');
    await fs.mkdir(projectSessionDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeJsonFile(path.join(projectSessionDir, `session_${timestamp}.json`), {
      ...req.body, projectId, timestamp: new Date().toISOString(), recordedAt: timestamp
    });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save session', details: error.message });
  }
});

app.get('/api/:projectId/sessions', async (req, res) => {
  try {
    const projectSessionDir = path.join(projectsDir, req.params.projectId, 'sessions');
    let files = [];
    try { files = await fs.readdir(projectSessionDir); } catch { return res.json({ sessions: [] }); }
    const sessions = (await Promise.all(
      files.filter(f => f.endsWith('.json')).map(f => readJsonFile(path.join(projectSessionDir, f)))
    )).filter(Boolean);
    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read sessions', details: error.message });
  }
});

// ============ START ============

app.listen(PORT, async () => {
  try {
    await initDatabase();
  } catch (err) {
    console.error('WARN: TiDB init failed:', err.message);
  }
  console.log(`Analytics API server running on port ${PORT}`);
});
