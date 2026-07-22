import express from 'express';

const sessionRouter = express.Router({ mergeParams: true });

let pool = null;

export function setSessionPool(mysqlPool) {
  pool = mysqlPool;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];

  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  return (
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}


// ======================================================
// SAVE RRWEB SESSION CHUNK
// POST /api/custom/:projectId/session
// ======================================================

sessionRouter.post('/', async (req, res) => {
  if (!pool) {
    return res.status(500).json({
      error: 'Database not initialized'
    });
  }

  try {
    const { projectId } = req.params;

    const ip = getClientIp(req);
    const now = new Date();

    const recordedAt = now
      .toISOString()
      .replace(/[:.]/g, '-');


    const sessionData = {
      ...req.body,
      projectId,
      ip,
      timestamp: now.toISOString(),
      recordedAt,
      recordedVia: 'custom'
    };


    await pool.execute(
      `
      INSERT INTO sessions
      (
        project_id,
        session_data,
        timestamp,
        recorded_at
      )
      VALUES (?, ?, ?, ?)
      `,
      [
        projectId,
        JSON.stringify(sessionData),
        now,
        recordedAt
      ]
    );


    res.json({
      success: true,
      recorded: true
    });


  } catch (error) {

    console.error(
      'Session save error:',
      error.message
    );

    res.status(500).json({
      error: 'Failed to save session'
    });

  }
});



// ======================================================
// LIST SESSIONS (WITHOUT RRWEB DATA)
// GET /api/custom/:projectId/session
// ======================================================

sessionRouter.get('/', async (req, res) => {

  if (!pool) {
    return res.status(500).json({
      error: 'Database not initialized'
    });
  }


  try {

    const { projectId } = req.params;


    const limit = Math.min(
      Number(req.query.limit) || 50,
      100
    );


    const offset =
      Number(req.query.offset) || 0;



    const [rows] = await pool.execute(
      `
      SELECT
        id,
        JSON_UNQUOTE(
          JSON_EXTRACT(session_data,'$.sessionId')
        ) AS sessionId,

        JSON_UNQUOTE(
          JSON_EXTRACT(session_data,'$.visitorId')
        ) AS visitorId,

        timestamp,
        recorded_at

      FROM sessions

      WHERE project_id = ?

      ORDER BY id DESC

      LIMIT ?
      OFFSET ?
      `,
      [
        projectId,
        limit,
        offset
      ]
    );


    res.json({
      sessions: rows,
      limit,
      offset
    });


  } catch(error) {

    console.error(
      'Session list error:',
      error.message
    );


    res.status(500).json({
      error:'Failed to fetch sessions'
    });

  }

});




// ======================================================
// FETCH ONE SESSION REPLAY
// GET /api/custom/:projectId/session/:sessionId
// ======================================================

sessionRouter.get('/:sessionId', async (req, res) => {

  if (!pool) {
    return res.status(500).json({
      error:'Database not initialized'
    });
  }


  try {

    const {
      projectId,
      sessionId
    } = req.params;


    const limit = Math.min(
      Number(req.query.limit) || 500,
      1000
    );


    const offset =
      Number(req.query.offset) || 0;



    const [rows] = await pool.execute(
      `
      SELECT
        session_data

      FROM sessions

      WHERE project_id = ?

      AND JSON_UNQUOTE(
          JSON_EXTRACT(session_data,'$.sessionId')
      ) = ?

      ORDER BY id ASC

      LIMIT ?
      OFFSET ?
      `,
      [
        projectId,
        sessionId,
        limit,
        offset
      ]
    );



    const events = [];


    for (const row of rows) {

      const data =
        typeof row.session_data === 'string'
          ? JSON.parse(row.session_data)
          : row.session_data;


      if (Array.isArray(data.events)) {

        events.push(
          ...data.events
        );

      }

    }



    res.json({

      sessionId,

      events,

      nextOffset:
        offset + rows.length,

      hasMore:
        rows.length === limit

    });



  } catch(error) {


    console.error(
      'Replay fetch error:',
      error.message
    );


    res.status(500).json({
      error:'Failed to fetch replay'
    });

  }

});


export default sessionRouter;
