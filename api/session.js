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
    req.socket?.remoteAddress ||
    'unknown'
  );
}



// ======================================================
// SAVE RRWEB CHUNK
// POST /api/custom/:projectId/session
// ======================================================

sessionRouter.post('/', async (req,res)=>{

  if(!pool)
    return res.status(500).json({
      error:"Database not initialized"
    });


  try{

    const {projectId}=req.params;

    const now=new Date();

    const recordedAt =
      now.toISOString().replace(/[:.]/g,'-');


    const sessionData={

      ...req.body,

      projectId,

      ip:getClientIp(req),

      recordedAt,

      timestamp:now.toISOString(),

      recordedVia:"custom"

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
      VALUES (?,?,?,?)
      `,
      [
        projectId,
        JSON.stringify(sessionData),
        now,
        recordedAt
      ]
    );


    res.json({
      success:true,
      recorded:true
    });


  }catch(error){

    console.error(error);

    res.status(500).json({
      error:"Session save failed"
    });

  }

});





// ======================================================
// SESSION LIST
// Metadata only - no rrweb events
//
// GET /api/custom/:projectId/session
// ======================================================

sessionRouter.get('/', async(req,res)=>{


  if(!pool)
    return res.status(500).json({
      error:"Database not initialized"
    });


  try{


    const {projectId}=req.params;


    const limit=Math.min(
      Number(req.query.limit)||50,
      100
    );


    const offset=
      Number(req.query.offset)||0;



    const [rows]=await pool.execute(

      `
      SELECT

      id,

      JSON_UNQUOTE(
        JSON_EXTRACT(session_data,'$.sessionId')
      ) sessionId,


      JSON_UNQUOTE(
        JSON_EXTRACT(session_data,'$.visitorId')
      ) visitorId,


      JSON_UNQUOTE(
        JSON_EXTRACT(session_data,'$.ip')
      ) ip,


      JSON_UNQUOTE(
        JSON_EXTRACT(session_data,'$.url')
      ) url,


      JSON_UNQUOTE(
        JSON_EXTRACT(session_data,'$.userAgent')
      ) userAgent,


      JSON_UNQUOTE(
        JSON_EXTRACT(session_data,'$.screenResolution')
      ) screenResolution,


      JSON_EXTRACT(
        session_data,
        '$.viewportWidth'
      ) viewportWidth,


      JSON_EXTRACT(
        session_data,
        '$.viewportHeight'
      ) viewportHeight,


      timestamp,

      recorded_at


      FROM sessions


      WHERE project_id=?


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

    console.error(error);

    res.status(500).json({
      error:"Session list failed"
    });

  }

});







// ======================================================
// LOAD ONE COMPLETE SESSION REPLAY
//
// GET /api/custom/:projectId/session/:sessionId
// ======================================================

sessionRouter.get('/:sessionId',async(req,res)=>{


  if(!pool)
    return res.status(500).json({
      error:"Database not initialized"
    });



  try{


    const {
      projectId,
      sessionId
    }=req.params;



    const [rows]=await pool.execute(

      `
      SELECT session_data

      FROM sessions

      WHERE project_id=?

      AND JSON_UNQUOTE(
        JSON_EXTRACT(session_data,'$.sessionId')
      )=?


      ORDER BY id ASC

      `,

      [
        projectId,
        sessionId
      ]

    );



    if(rows.length===0)
      return res.status(404).json({
        error:"Session not found"
      });



    const events=[];

    let details={};



    for(const row of rows){


      const data=
        typeof row.session_data==="string"
        ? JSON.parse(row.session_data)
        : row.session_data;



      if(!details.sessionId){

        details={

          sessionId:data.sessionId,

          visitorId:data.visitorId,

          ip:data.ip,

          url:data.url,

          userAgent:data.userAgent,

          screenResolution:data.screenResolution,

          viewportWidth:data.viewportWidth,

          viewportHeight:data.viewportHeight,

          timestamp:data.timestamp

        };

      }



      if(Array.isArray(data.events)){

        events.push(...data.events);

      }

    }



    res.json({

      ...details,

      events,

      chunks:rows.length,

      totalEvents:events.length

    });



  }catch(error){

    console.error(error);

    res.status(500).json({
      error:"Replay load failed"
    });

  }

});







// ======================================================
// DELETE SESSION
//
// DELETE /api/custom/:projectId/session/:sessionId
// ======================================================

sessionRouter.delete('/:sessionId',async(req,res)=>{


  if(!pool)
    return res.status(500).json({
      error:"Database not initialized"
    });



  try{


    const {
      projectId,
      sessionId
    }=req.params;



    await pool.execute(

      `
      DELETE FROM sessions

      WHERE project_id=?

      AND JSON_UNQUOTE(
        JSON_EXTRACT(session_data,'$.sessionId')
      )=?

      `,

      [
        projectId,
        sessionId
      ]

    );


    res.json({
      success:true,
      deleted:true
    });



  }catch(error){

    console.error(error);

    res.status(500).json({
      error:"Delete failed"
    });

  }

});



export default sessionRouter;
