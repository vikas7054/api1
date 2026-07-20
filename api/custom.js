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

// ============ CUSTOM TRACKING SCRIPT (per project) ============

const DEFAULT_TRACKING_SCRIPT = ` // Web Analytics Tracking Script
//
// HOW TO TURN THINGS ON/OFF:
// Just edit the CONFIG object below. No dashboard, no HTML needed.
//   rrwebRecording: true  -> session replay recording auto-starts (default)
//   rrwebRecording: false -> session replay never starts, nothing sent for it
//   eventTracking:  true  -> pageview/click/custom events send to API (default)
//   eventTracking:  false -> events are blocked locally, nothing sent
//   autoClicks:     true  -> clicks are tracked automatically (default)
//   autoClicks:     false -> clicks are not tracked
//
// These same 3 switches can ALSO be controlled at runtime from your own code:
//   window.AnalyticsTracker.stopSession() / startSession()
//   window.AnalyticsTracker.disableEvents() / enableEvents()
//   window.AnalyticsTracker.disableAutoClicks() / enableAutoClicks()
//
// Single-tag install — server injects the project ID automatically:
//   <script src="https://api1-orpin.vercel.app/api/custom/PROJECT_ID/tracking.js" defer></script>
(function() {
  const API_URL = 'https://api1-orpin.vercel.app/api/custom';
  const RRWEB_URL = 'https://unpkg.com/rrweb@2.0.0-alpha.4/dist/rrweb.min.js';

  // ---- EDIT THESE TO SET DEFAULTS FOR THIS PROJECT ----
  const CONFIG = {
    rrwebRecording: true,   // session replay recording — ON
    eventTracking: true,    // pageview / click / custom events — on by default
    autoClicks: true,       // automatic click capture — on by default
    inactivityTimeoutMinutes: 5, // after this many minutes with no interaction, stop sending;
                                  // a new session ID is issued when the user comes back.
                                  // Set to false (or 0) to turn this off completely —
                                  // script then behaves exactly like before, no timeout at all.
    mouseMoveSampling: 20   // ms between recorded mouse positions.
                            // Lower (e.g. 20) = smoother replay, more data sent.
                            // Higher (e.g. 300-500) = choppier replay, less data sent.
                            // Set very high (e.g. 999999) to basically only capture clicks,
                            // not continuous movement.
  };
  // -------------------------------------------------------

  let events = [];
  let recording = false;
  let stopFn = null;
  let sendInterval = null;
  let projectId = '__PROJECT_ID__';
  let rrwebLoading = false;
  let rrwebCallbacks = [];
  let autoClicksEnabled = false;
  let clickHandler = null;
  let eventsOn = CONFIG.eventTracking;
  let lastActivityTime = Date.now();
  let isInactive = false;
  let inactivityCheckInterval = null;

  function generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function ensureRrwebLoaded(callback) {
    if (typeof rrweb !== 'undefined') { callback(); return; }
    rrwebCallbacks.push(callback);
    if (rrwebLoading) return;
    rrwebLoading = true;
    var s = document.createElement('script');
    s.src = RRWEB_URL;
    s.onload = function() {
      rrwebCallbacks.forEach(function(cb) { cb(); });
      rrwebCallbacks = [];
    };
    s.onerror = function() { console.warn('Analytics: Failed to load rrweb'); };
    document.head.appendChild(s);
  }

  function getProjectId() { return projectId; }

  function getVisitorId() {
    let visitorId = localStorage.getItem('visitorId');
    if (!visitorId) {
      visitorId = generateId();
      localStorage.setItem('visitorId', visitorId);
    }
    return visitorId;
  }

  function getSessionId() {
    let sessionId = sessionStorage.getItem('sessionId');
    if (!sessionId) {
      sessionId = generateId();
      sessionStorage.setItem('sessionId', sessionId);
    }
    return sessionId;
  }

  // ---- Inactivity handling ----
  // If there's no interaction for CONFIG.inactivityTimeoutMinutes, stop sending
  // data to the API and drop whatever's buffered. When the user interacts again,
  // a brand new session ID is issued — nothing after resuming uses the old one.
  function startNewSessionAfterInactivity() {
    const newId = generateId();
    sessionStorage.setItem('sessionId', newId);
    events = []; // discard anything buffered from before the gap, it's stale

    // rrweb only records a full DOM snapshot once, at the moment recording starts.
    // Everything after that is incremental diffs. Since the recorder itself never
    // stopped while inactive, the new session needs its own full snapshot as the
    // first event, or the player has nothing to reconstruct the page from.
    if (recording && typeof rrweb !== 'undefined' && rrweb.record && typeof rrweb.record.takeFullSnapshot === 'function') {
      rrweb.record.takeFullSnapshot();
    }
  }

  function handleActivity() {
    if (isInactive) {
      isInactive = false;
      startNewSessionAfterInactivity();
    }
    lastActivityTime = Date.now();
  }

  function checkInactivity() {
    if (!CONFIG.inactivityTimeoutMinutes) return; // feature disabled, do nothing
    if (isInactive) return;
    const timeoutMs = CONFIG.inactivityTimeoutMinutes * 60 * 1000;
    if (Date.now() - lastActivityTime >= timeoutMs) {
      isInactive = true;
      events = []; // stop carrying stale buffered data forward
    }
  }

  function startInactivityWatcher() {
    if (!CONFIG.inactivityTimeoutMinutes) return; // feature disabled — old behavior, no watcher at all
    ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'].forEach(function(evt) {
      document.addEventListener(evt, handleActivity, { passive: true });
    });
    if (inactivityCheckInterval) clearInterval(inactivityCheckInterval);
    inactivityCheckInterval = setInterval(checkInactivity, 30000); // check every 30s
  }

  // ---- Session recording (rrweb) ----
  function startRecording() {
    if (recording || !getProjectId()) return;

    ensureRrwebLoaded(function() {
      if (recording) return;

      stopFn = rrweb.record({
        emit(event) {
          events.push(event);
          if (events.length >= 10) sendEvents();
        },
        recordCanvas: true,
        recordAfter: 'DOMContentLoaded',
        maskAllInputs: false,
        maskTextSelector: '[data-mask]',
        slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true },
        sampling: { canvas: 10, input: 'last', scroll: 150, media: 500, mousemove: CONFIG.mouseMoveSampling },
        dataURLOptions: { type: 'image/webp', quality: 0.8 },
        inlineStylesheet: true
      });

      recording = true;
      if (sendInterval) clearInterval(sendInterval);
      sendInterval = setInterval(sendEvents, 5000);
    });
  }

  function stopRecording() {
    if (!recording) return;
    if (typeof stopFn === 'function') { stopFn(); stopFn = null; }
    if (sendInterval) { clearInterval(sendInterval); sendInterval = null; }
    recording = false;
    sendEvents(); // flush what's left
  }

  async function sendEvents() {
    if (isInactive) return; // paused — user inactive past the timeout
    if (events.length === 0 || !getProjectId()) return;

    const eventsToSend = events.splice(0, events.length);
    const sessionData = {
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

    try {
      await fetch(API_URL + '/' + getProjectId() + '/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionData),
      });
    } catch (error) {
      console.error('Failed to send session data:', error);
      events.unshift(...eventsToSend);
    }
  }

  // ---- Events (pageview / click / custom) ----
  function trackEvent(eventName, eventData) {
    if (isInactive) return; // paused — user inactive past the timeout
    if (!eventsOn) {
      console.warn('Analytics: eventTracking is OFF (CONFIG.eventTracking / disableEvents()) — "' + eventName + '" was NOT sent.');
      return;
    }
    if (!getProjectId()) {
      console.warn('Analytics: No project ID configured.');
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

    fetch(API_URL + '/' + getProjectId() + '/events/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).catch(console.error);
  }

  function trackPageview() { trackEvent('pageview'); }

  function handleClick(e) {
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
  }

  function enableAutoClicks() {
    if (autoClicksEnabled) return;
    clickHandler = handleClick;
    document.addEventListener('click', clickHandler);
    autoClicksEnabled = true;
  }

  function disableAutoClicks() {
    if (!autoClicksEnabled) return;
    document.removeEventListener('click', clickHandler);
    clickHandler = null;
    autoClicksEnabled = false;
  }

  function enableEvents() { eventsOn = true; }
  function disableEvents() { eventsOn = false; }

  // Mouse tracking presets. rrweb's sampling rate is locked in when recording
  // starts, so switching it means restarting the recorder (which also takes
  // a fresh full snapshot, same as the inactivity-resume flow above).
  function setMouseTrackingSmooth() {
    CONFIG.mouseMoveSampling = 20;
    if (recording) { stopRecording(); startRecording(); }
  }

  function setMouseTrackingLight() {
    CONFIG.mouseMoveSampling = 500;
    if (recording) { stopRecording(); startRecording(); }
  }

  function setProjectId(pId) { projectId = pId; }

  function init(pId) {
    if (pId) projectId = pId;

    startInactivityWatcher();

    if (CONFIG.rrwebRecording) startRecording();
    if (CONFIG.eventTracking) trackPageview();
    if (CONFIG.autoClicks) enableAutoClicks();
  }

  window.addEventListener('beforeunload', () => {
    if (recording) {
      if (sendInterval) clearInterval(sendInterval);
      sendEvents();
    }
  });

  // Auto-init: project ID is already injected server-side.
  if (projectId) {
    if (document.readyState === 'complete') {
      init(projectId);
    } else {
      window.addEventListener('load', function() { init(projectId); });
    }
  }

  // ============================================================
  // EXAMPLE: custom events — DISABLED by default, just a template.
  // Everything below is commented out, so none of it runs on its own.
  // Each example is wired to a REAL element with addEventListener, so if
  // you uncomment one, give the matching id="..." to your actual HTML
  // element and it will just work — no page-load misfires.
  // ============================================================
  //
  // Track a custom event with optional data (call this from anywhere
  // in your own code, at the exact moment you want it to fire):
  // trackEvent('event_name', {
  //   category: 'category',
  //   label: 'label',
  //   value: 123
  // });
  //
  // Form Submissions — put id="contact-form" on your <form>
  // document.getElementById('contact-form')?.addEventListener('submit', function() {
  //   trackEvent('form_submit', {
  //     formId: 'contact',
  //     success: true
  //   });
  // });
  //
  // Feature Usage — put id="search-input" on your search box, fires after Enter
  // document.getElementById('search-input')?.addEventListener('keydown', function(e) {
  //   if (e.key === 'Enter') {
  //     trackEvent('feature_used', {
  //       feature: 'search',
  //       query: e.target.value
  //     });
  //   }
  // });
  //
  // CTA Clicks — put id="signup-hero-btn" on your button/link
  // document.getElementById('signup-hero-btn')?.addEventListener('click', function() {
  //   trackEvent('cta_click', {
  //     ctaId: 'signup-hero',
  //     location: 'header'
  //   });
  // });
  //
  // ============================================================

  // Runtime control, in case you want to flip things without editing CONFIG.
  window.trackEvent = trackEvent;
  window.AnalyticsTracker = {
    init: init,
    setProjectId: setProjectId,
    startSession: startRecording,
    stopSession: stopRecording,
    isRecording: function() { return recording; },
    enableEvents: enableEvents,
    disableEvents: disableEvents,
    isEventsOn: function() { return eventsOn; },
    trackEvent: trackEvent,
    trackPageview: trackPageview,
    enableAutoClicks: enableAutoClicks,
    disableAutoClicks: disableAutoClicks,
    isAutoClicksEnabled: function() { return autoClicksEnabled; },
    isInactive: function() { return isInactive; },
    getLastActivityTime: function() { return lastActivityTime; },
    setMouseTrackingSmooth: setMouseTrackingSmooth,
    setMouseTrackingLight: setMouseTrackingLight,
    getProjectId: getProjectId,
    getVisitorId: getVisitorId,
    getSessionId: getSessionId
  };
})();`;

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
      // No custom script saved yet — return default and persist it
      scriptContent = DEFAULT_TRACKING_SCRIPT;
      await pool.execute(
        'INSERT INTO tracking_scripts (project_id, script_content) VALUES (?, ?)',
        [projectId, scriptContent]
      );
    }

    // Inject the real project ID server-side so the client doesn't need to detect it
    scriptContent = scriptContent.replace(/__PROJECT_ID__/g, projectId);

    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=60');
    res.send(scriptContent);
  } catch (error) {
    console.error('Custom API: Get tracking script error:', error.message);
    res.status(500).json({ error: 'Failed to fetch tracking script', details: error.message });
  }
});

// GET /:projectId/tracking-script — return script as JSON (for editor)
customRouter.get('/:projectId/tracking-script', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;

    const [rows] = await pool.execute(
      'SELECT script_content, updated_at FROM tracking_scripts WHERE project_id = ?',
      [projectId]
    );

    let scriptContent;
    let updatedAt = null;
    if (rows.length > 0) {
      scriptContent = rows[0].script_content;
      updatedAt = rows[0].updated_at;
    } else {
      scriptContent = DEFAULT_TRACKING_SCRIPT;
      await pool.execute(
        'INSERT INTO tracking_scripts (project_id, script_content) VALUES (?, ?)',
        [projectId, scriptContent]
      );
    }

    res.json({ projectId, scriptContent, updatedAt });
  } catch (error) {
    console.error('Custom API: Get tracking script (JSON) error:', error.message);
    res.status(500).json({ error: 'Failed to fetch tracking script', details: error.message });
  }
});

// PUT /:projectId/tracking-script — save/update the custom tracking script
customRouter.put('/:projectId/tracking-script', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;
    const { scriptContent } = req.body;

    if (!scriptContent || typeof scriptContent !== 'string') {
      return res.status(400).json({ error: 'scriptContent is required' });
    }

    await pool.execute(
      `INSERT INTO tracking_scripts (project_id, script_content)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE script_content = VALUES(script_content)`,
      [projectId, scriptContent]
    );

    res.json({ success: true, projectId, message: 'Tracking script updated' });
  } catch (error) {
    console.error('Custom API: Save tracking script error:', error.message);
    res.status(500).json({ error: 'Failed to save tracking script', details: error.message });
  }
});

// POST /:projectId/tracking-script/reset — reset to default
customRouter.post('/:projectId/tracking-script/reset', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not initialized' });

  try {
    const { projectId } = req.params;

    await pool.execute(
      `INSERT INTO tracking_scripts (project_id, script_content)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE script_content = VALUES(script_content)`,
      [projectId, DEFAULT_TRACKING_SCRIPT]
    );

    res.json({ success: true, projectId, scriptContent: DEFAULT_TRACKING_SCRIPT, message: 'Tracking script reset to default' });
  } catch (error) {
    console.error('Custom API: Reset tracking script error:', error.message);
    res.status(500).json({ error: 'Failed to reset tracking script', details: error.message });
  }
});

export default customRouter;
