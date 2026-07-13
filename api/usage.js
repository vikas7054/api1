/**
 * Usage & Plan API Routes
 * Tracks per-user plan and resource usage (events, sessions, projects, storage).
 * Routes mounted under /api/usage/
 */

import express from 'express';
import mysql from 'mysql2/promise';

const usageRouter = express.Router();

let pool = null;

export function setUsagePool(mysqlPool) {
  pool = mysqlPool;
}

// Fallback standalone pool (same config as server.js)
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
  console.error('Usage API: Standalone fallback database connection failed:', err.message);
}

// Plan definitions with limits
const PLAN_LIMITS = {
  free: { events: 10000, sessions: 1000, projects: 3, storage_mb: 500 },
  pro: { events: 100000, sessions: 10000, projects: 25, storage_mb: 5000 },
  enterprise: { events: 1000000, sessions: 100000, projects: 100, storage_mb: 50000 },
};

// Initialize user_plans table
export async function initUsageDatabase() {
  if (!pool) return;
  const conn = await pool.getConnection();
  try {
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
    console.log('TiDB: user_plans table verified and ready');
  } finally {
    conn.release();
  }
}

// Get or create a user's plan row
async function getOrCreatePlan(userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM user_plans WHERE user_id = ?',
    [userId]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  // Create a new plan row for this user
  const { randomUUID } = await import('crypto');
  const id = randomUUID();
  await pool.execute(
    'INSERT INTO user_plans (id, user_id, plan, billing_cycle_end) VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))',
    [id, userId, 'free']
  );

  const [newRows] = await pool.execute(
    'SELECT * FROM user_plans WHERE user_id = ?',
    [userId]
  );
  return newRows[0];
}

// Compute real-time usage by counting rows across projects owned by the user
async function computeUsage(userId) {
  // Count projects
  const [projectRows] = await pool.execute(
    'SELECT COUNT(*) as count FROM projects WHERE user_id = ?',
    [userId]
  );
  const projectsUsed = projectRows[0]?.count || 0;

  // Get all project IDs for this user
  const [projectIds] = await pool.execute(
    'SELECT id FROM projects WHERE user_id = ?',
    [userId]
  );
  const ids = projectIds.map((r) => r.id);

  let eventsUsed = 0;
  let sessionsUsed = 0;
  let storageUsedMb = 0;

  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');

    const [eventRows] = await pool.execute(
      `SELECT COUNT(*) as count FROM events WHERE project_id IN (${placeholders})`,
      ids
    );
    eventsUsed = eventRows[0]?.count || 0;

    const [sessionRows] = await pool.execute(
      `SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(session_data)), 0) as totalSize FROM sessions WHERE project_id IN (${placeholders})`,
      ids
    );
    sessionsUsed = sessionRows[0]?.count || 0;
    storageUsedMb = Number(((sessionRows[0]?.totalSize || 0) / (1024 * 1024)).toFixed(2));
  }

  return { eventsUsed, sessionsUsed, projectsUsed, storageUsedMb };
}

// GET /api/usage/:userId — returns plan + real-time usage
usageRouter.get('/:userId', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const planRow = await getOrCreatePlan(userId);
    const usage = await computeUsage(userId);
    const limits = PLAN_LIMITS[planRow.plan] || PLAN_LIMITS.free;

    res.json({
      userId,
      plan: planRow.plan,
      billingCycleStart: planRow.billing_cycle_start,
      billingCycleEnd: planRow.billing_cycle_end,
      usage: {
        events: { used: usage.eventsUsed, limit: limits.events },
        sessions: { used: usage.sessionsUsed, limit: limits.sessions },
        projects: { used: usage.projectsUsed, limit: limits.projects },
        storage: { used: usage.storageUsedMb, limit: limits.storage_mb },
      },
    });
  } catch (error) {
    console.error('Usage API: GET error:', error.message);
    res.status(500).json({ error: 'Failed to fetch usage', details: error.message });
  }
});

// PUT /api/usage/:userId/plan — update the user's plan
usageRouter.put('/:userId/plan', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { userId } = req.params;
    const { plan } = req.body;

    if (!plan || !PLAN_LIMITS[plan]) {
      return res.status(400).json({ error: 'Invalid plan. Must be one of: free, pro, enterprise' });
    }

    const planRow = await getOrCreatePlan(userId);
    await pool.execute(
      'UPDATE user_plans SET plan = ? WHERE user_id = ?',
      [plan, userId]
    );

    res.json({ userId, plan, message: 'Plan updated successfully' });
  } catch (error) {
    console.error('Usage API: PUT plan error:', error.message);
    res.status(500).json({ error: 'Failed to update plan', details: error.message });
  }
});

export default usageRouter;
