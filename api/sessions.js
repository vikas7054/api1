import express from 'express';

const sessionRouter = express.Router({ mergeParams: true });

let pool = null;

export function setSessionPool(mysqlPool) {
  pool = mysqlPool;
}


// Get real IP
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];

  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  return (
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
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

    const now = new Date();

    const recordedAt = now
      .toISOString()
      .replace(/[:.]/g, '-');


    const fullSessionData = {

      ...req.body,

      projectId,

      ip: getClientIp(req),

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
        JSON.stringify(fullSessionData),
        now,
        recordedAt
      ]

    );



    res.json({
      success:true,
      recorded:true
    });



  } catch(error) {


    console.error(
      "Session save error:",
      error.message
    );


    res.status(500).json({
      error:"Failed to save session"
    });

  }

});




// ======================================================
// LIST SESSIONS
// Only metadata
// GET /api/custom/:projectId/session
// ======================================================

sessionRouter.get('/', async(req,res)=>{


  if(!pool){

    return res.status(500).json({
      error:'Database not initialized'
    });

  }


  try {


    const { projectId } = req.params;


    const limit =
      Math.min(
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

      sessions:rows,

      limit,

      offset

    });



  }catch(error){


    console.error(
      "Session list error:",
      error.message
    );


    res.status(500).json({
      error:"Failed to fetch sessions"
    });


  }

});






// ======================================================
// GET COMPLETE ONE SESSION REPLAY
//
// GET /api/custom/:projectId/session/:sessionId
//
// No limit because one sessionId is already isolated
// ======================================================

sessionRouter.get('/:sessionId', async(req,res)=>{


  if(!pool){

    return res.status(500).json({
      error:'Database not initialized'
    });

  }



  try{


    const {
      projectId,
      sessionId
    } = req.params;



    const [rows] = await pool.execute(

      `
      SELECT session_data

      FROM sessions

      WHERE project_id = ?

      AND JSON_UNQUOTE(
        JSON_EXTRACT(session_data,'$.sessionId')
      ) = ?

      ORDER BY id ASC

      `,

      [
        projectId,
        sessionId
      ]

    );



    if(rows.length === 0){

      return res.status(404).json({

        error:"Session not found"

      });

    }




    const events = [];

    let sessionInfo = {};



    for(const row of rows){


      const data =
        typeof row.session_data === "string"
        ? JSON.parse(row.session_data)
        : row.session_data;



      if(!sessionInfo.sessionId){

        sessionInfo = {

          sessionId:data.sessionId,

          visitorId:data.visitorId,

          url:data.url,

          userAgent:data.userAgent,

          timestamp:data.timestamp

        };

      }



      if(Array.isArray(data.events)){

        events.push(
          ...data.events
        );

      }

    }



    res.json({

      ...sessionInfo,

      events,

      totalChunks: rows.length,

      totalEvents: events.length

    });



  }catch(error){


    console.error(
      "Replay fetch error:",
      error.message
    );


    res.status(500).json({

      error:"Failed to load replay"

    });


  }

});



export default sessionRouter;
