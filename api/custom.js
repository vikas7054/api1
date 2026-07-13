/**
 * Custom Analytics API Routes
 * Optimized for Option 3 tracking with efficient data handling
 * Routes mounted under /api/custom/
 */

import express from 'express';
import mysql from 'mysql2/promise'; // Added missing driver import

const customRouter = express.Router();

// Initialize the single pool variable reference
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

// Exportable setter function for server.js to pass its pool instance
export function setCustomPool(mysqlPool) {
  pool = mysqlPool;
}

// Fallback configuration block: Creates a standalone local fallback pool if server.js doesn't provide one
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
  console.error('Custom API: Standalone fallback database connection failed:', err.message);
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

// ============ SESSION BATCH ENDPOINT ============

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

    const [sessionRows] = await pool.execute(
      'SELECT COUNT(*) as count FROM sessions WHERE project_id = ?',
      [projectId]
    );

    const [eventRows] = await pool.execute(
      'SELECT COUNT(*) as count FROM events WHERE project_id = ?',
      [projectId]
    );

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

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const [sessionsResult] = await pool.execute(
      'DELETE FROM sessions WHERE project_id = ? AND timestamp < ?',
      [projectId, cutoff]
    );

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

// ============ CUSTOM TRACKING SCRIPT (per project, settings-driven) ============

const DEFAULT_SETTINGS = {
  apiUrl: 'https://api1-orpin.vercel.app/api/custom',
  sessionRecording: true,
  clickTracking: true,
  scrollTracking: false,
  inputMasking: false,
  batchSize: 10,
  sendIntervalMs: 5000,
  canvasRecording: true,
  inlineStylesheet: true,
  autoLoadRrweb: true,
  rrwebUrl: 'https://unpkg.com/rrweb@2.0.0-alpha.4/dist/rrweb.min.js',
  debugMode: false,
};

function generateTrackingScript(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const apiUrl = s.apiUrl;
  const rrwebUrl = s.rrwebUrl;

  return `// Analytics Tracking Script (auto-generated from settings)
// Auto-detects Project ID from this script's src URL, or uses window.ANALYTICS_PROJECT_ID
(function() {
  var API_URL = ${JSON.stringify(apiUrl)};
  var RRWEB_URL = ${JSON.stringify(rrwebUrl)};
  var SESSION_RECORDING = ${s.sessionRecording};
  var CLICK_TRACKING = ${s.clickTracking};
  var SCROLL_TRACKING = ${s.scrollTracking};
  var INPUT_MASKING = ${s.inputMasking};
  var BATCH_SIZE = ${s.batchSize};
  var SEND_INTERVAL_MS = ${s.sendIntervalMs};
  var CANVAS_RECORDING = ${s.canvasRecording};
  var INLINE_STYLESHEET = ${s.inlineStylesheet};
  var AUTO_LOAD_RRWEB = ${s.autoLoadRrweb};
  var DEBUG_MODE = ${s.debugMode};

  var events = [];
  var recording = false;
  var stopFn = null;
  var sendInterval = null;
  var projectId = null;
  var scrollTimeout = null;

  function debug() {
    if (DEBUG_MODE && console) console.log.apply(console, ['[Analytics]'].concat(Array.prototype.slice.call(arguments)));
  }

  function generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Auto-detect project ID from this script's src URL: /api/custom/{projectId}/tracking.js
  function detectProjectIdFromScriptSrc() {
    var scripts = document.querySelectorAll('script[src*="/tracking.js"]');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].getAttribute('src') || '';
      var match = src.match(/\\/api\\/custom\\/([a-f0-9-]{36})\\/tracking\\.js/);
      if (match) return match[1];
    }
    return null;
  }

  function getProjectId() {
    if (projectId) return projectId;
    // 1. Explicit window var
    if (window.ANALYTICS_PROJECT_ID) {
      projectId = window.ANALYTICS_PROJECT_ID;
      return projectId;
    }
    // 2. Auto-detect from script src URL
    projectId = detectProjectIdFromScriptSrc();
    return projectId;
  }

  function getVisitorId() {
    var visitorId = localStorage.getItem('visitorId');
    if (!visitorId) {
      visitorId = generateId();
      localStorage.setItem('visitorId', visitorId);
    }
    return visitorId;
  }

  function getSessionId() {
    var sessionId = sessionStorage.getItem('sessionId');
    if (!sessionId) {
      sessionId = generateId();
      sessionStorage.setItem('sessionId', sessionId);
    }
    return sessionId;
  }

  function loadScript(url, onLoad, onError) {
    var s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = onLoad;
    s.onerror = onError || function() { debug('Failed to load: ' + url); };
    document.head.appendChild(s);
  }

  function startRecording() {
    if (!SESSION_RECORDING || recording || !getProjectId()) return;
    if (typeof rrweb === 'undefined') {
      if (AUTO_LOAD_RRWEB) {
        debug('rrweb not found, auto-loading from ' + RRWEB_URL);
        loadScript(RRWEB_URL, function() {
          debug('rrweb loaded, starting recording');
          startRecording();
        });
        return;
      }
      debug('Session recording enabled but rrweb not loaded and autoLoad is off');
      return;
    }

    stopFn = rrweb.record({
      emit: function(event) {
        events.push(event);
        if (events.length >= BATCH_SIZE) {
          sendEvents();
        }
      },
      recordCanvas: CANVAS_RECORDING,
      recordAfter: 'DOMContentLoaded',
      maskAllInputs: INPUT_MASKING,
      maskTextSelector: '[data-mask]',
      slimDOMOptions: {
        script: true,
        comment: true,
        headFavicon: true,
        headWhitespace: true
      },
      sampling: {
        canvas: 10,
        input: 'last',
        scroll: 150,
        media: 500
      },
      dataURLOptions: {
        type: 'image/webp',
        quality: 0.8
      },
      inlineStylesheet: INLINE_STYLESHEET
    });

    recording = true;
    debug('Session recording started');

    if (sendInterval) clearInterval(sendInterval);
    sendInterval = setInterval(sendEvents, SEND_INTERVAL_MS);

    window.addEventListener('beforeunload', function() {
      if (sendInterval) clearInterval(sendInterval);
      sendEvents();
    });
  }

  function sendEvents() {
    if (events.length === 0 || !getProjectId()) return;

    var eventsToSend = events.splice(0, events.length);
    var sessionData = {
      sessionId: getSessionId(),
      visitorId: getVisitorId(),
      timestamp: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
      screenResolution: window.screen.width + 'x' + window.screen.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      events: eventsToSend
    };

    debug('Sending ' + eventsToSend.length + ' session events');
    fetch(API_URL + '/' + getProjectId() + '/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionData)
    }).catch(function(err) {
      console.error('Failed to send session data:', err);
      events.unshift.apply(events, eventsToSend);
    });
  }

  function trackEvent(eventName, eventData) {
    if (!getProjectId()) {
      console.warn('[Analytics] No project ID configured. Set window.ANALYTICS_PROJECT_ID or use the auto-detect URL.');
      return;
    }

    var event = {
      timestamp: new Date().toISOString(),
      visitorId: getVisitorId(),
      sessionId: getSessionId(),
      eventName: eventName,
      url: window.location.href,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
      screenResolution: window.screen.width + 'x' + window.screen.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      language: navigator.language
    };
    if (eventData) Object.assign(event, eventData);

    debug('Track event: ' + eventName);
    fetch(API_URL + '/' + getProjectId() + '/events/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    }).catch(console.error);
  }

  function init(pId) {
    if (pId) projectId = pId;

    // Auto-load rrweb if session recording is enabled and rrweb is missing
    if (SESSION_RECORDING && typeof rrweb === 'undefined' && AUTO_LOAD_RRWEB) {
      loadScript(RRWEB_URL, function() {
        debug('rrweb auto-loaded');
        startRecording();
      });
    } else if (document.readyState === 'complete') {
      startRecording();
    } else {
      window.addEventListener('load', startRecording);
    }

    trackEvent('pageview');

    if (CLICK_TRACKING) {
      document.addEventListener('click', function(e) {
        var target = e.target.closest('a, button');
        if (target) {
          trackEvent('click', {
            elementType: target.tagName.toLowerCase(),
            elementText: target.textContent ? target.textContent.trim() : '',
            elementId: target.id,
            elementClass: target.className,
            clickX: e.clientX,
            clickY: e.clientY
          });
        }
      });
      debug('Click tracking enabled');
    }

    if (SCROLL_TRACKING) {
      window.addEventListener('scroll', function() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(function() {
          trackEvent('scroll', {
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            scrollPercent: Math.round((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100)
          });
        }, 500);
      });
      debug('Scroll tracking enabled');
    }
  }

  // Auto-init: detect project ID from script src or window var
  var detectedId = getProjectId();
  if (detectedId) {
    debug('Project ID detected: ' + detectedId);
    if (document.readyState === 'complete') {
      init(detectedId);
    } else {
      window.addEventListener('load', function() { init(detectedId); });
    }
  } else {
    debug('No project ID detected. Call window.AnalyticsTracker.init(projectId) manually.');
  }

  // Expose globally
  window.trackEvent = trackEvent;
  window.AnalyticsTracker = {
    init: init,
    trackEvent: trackEvent,
    getProjectId: getProjectId,
    getVisitorId: getVisitorId,
    getSessionId: getSessionId
  };
})();`;
}

const DEFAULT_TRACKING_SCRIPT = generateTrackingScript(DEFAULT_SETTINGS);

// GET /:projectId/tracking.js — serve the custom tracking script as JS
customRouter.get('/:projectId/tracking.js', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;

    const [rows] = await pool.execute(
      'SELECT script_content FROM tracking_scripts WHERE project_id = ?',
      [projectId]
    );

    let scriptContent;
    if (rows.length > 0) {
      scriptContent = rows[0].script_content;
    } else {
      scriptContent = DEFAULT_TRACKING_SCRIPT;
      await pool.execute(
        'INSERT INTO tracking_scripts (project_id, script_content, settings) VALUES (?, ?, ?)',
        [projectId, scriptContent, JSON.stringify(DEFAULT_SETTINGS)]
      );
    }

    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=60');
    res.send(scriptContent);
  } catch (error) {
    console.error('Custom API: Get tracking script error:', error.message);
    res.status(500).json({ error: 'Failed to fetch tracking script', details: error.message });
  }
});

// GET /:projectId/tracking-script — return script + settings as JSON (for editor)
customRouter.get('/:projectId/tracking-script', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;

    const [rows] = await pool.execute(
      'SELECT script_content, settings, updated_at FROM tracking_scripts WHERE project_id = ?',
      [projectId]
    );

    let scriptContent, settings, updatedAt;
    if (rows.length > 0) {
      scriptContent = rows[0].script_content;
      settings = rows[0].settings ? (typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : rows[0].settings) : DEFAULT_SETTINGS;
      updatedAt = rows[0].updated_at;
    } else {
      scriptContent = DEFAULT_TRACKING_SCRIPT;
      settings = DEFAULT_SETTINGS;
      await pool.execute(
        'INSERT INTO tracking_scripts (project_id, script_content, settings) VALUES (?, ?, ?)',
        [projectId, scriptContent, JSON.stringify(DEFAULT_SETTINGS)]
      );
    }

    res.json({ projectId, scriptContent, settings, updatedAt });
  } catch (error) {
    console.error('Custom API: Get tracking script (JSON) error:', error.message);
    res.status(500).json({ error: 'Failed to fetch tracking script', details: error.message });
  }
});

// PUT /:projectId/tracking-script — save/update the custom tracking script + settings
customRouter.put('/:projectId/tracking-script', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const { scriptContent, settings } = req.body;

    if (!scriptContent || typeof scriptContent !== 'string') {
      return res.status(400).json({ error: 'scriptContent is required' });
    }

    const settingsJson = settings ? JSON.stringify(settings) : null;

    await pool.execute(
      `INSERT INTO tracking_scripts (project_id, script_content, settings)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE script_content = VALUES(script_content), settings = VALUES(settings)`,
      [projectId, scriptContent, settingsJson]
    );

    res.json({ success: true, projectId, message: 'Tracking script and settings updated' });
  } catch (error) {
    console.error('Custom API: Save tracking script error:', error.message);
    res.status(500).json({ error: 'Failed to save tracking script', details: error.message });
  }
});

// POST /:projectId/tracking-script/generate — regenerate script from settings
customRouter.post('/:projectId/tracking-script/generate', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const { settings } = req.body;

    const mergedSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const scriptContent = generateTrackingScript(mergedSettings);

    await pool.execute(
      `INSERT INTO tracking_scripts (project_id, script_content, settings)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE script_content = VALUES(script_content), settings = VALUES(settings)`,
      [projectId, scriptContent, JSON.stringify(mergedSettings)]
    );

    res.json({ success: true, projectId, scriptContent, settings: mergedSettings, message: 'Script generated from settings' });
  } catch (error) {
    console.error('Custom API: Generate tracking script error:', error.message);
    res.status(500).json({ error: 'Failed to generate tracking script', details: error.message });
  }
});

// POST /:projectId/tracking-script/reset — reset to default
customRouter.post('/:projectId/tracking-script/reset', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;

    await pool.execute(
      `INSERT INTO tracking_scripts (project_id, script_content, settings)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE script_content = VALUES(script_content), settings = VALUES(settings)`,
      [projectId, DEFAULT_TRACKING_SCRIPT, JSON.stringify(DEFAULT_SETTINGS)]
    );

    res.json({ success: true, projectId, scriptContent: DEFAULT_TRACKING_SCRIPT, settings: DEFAULT_SETTINGS, message: 'Tracking script reset to default' });
  } catch (error) {
    console.error('Custom API: Reset tracking script error:', error.message);
    res.status(500).json({ error: 'Failed to reset tracking script', details: error.message });
  }
});

export default customRouter;
