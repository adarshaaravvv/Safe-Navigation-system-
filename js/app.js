/* ═══════════════════════════════════════════════════════════════════
   SATHI NAVIGATION — APP LOGIC
   Full feature simulation: routes, scoring, travel buddy, SOS
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── CONSTANTS ──────────────────────────────────────────────────────
const DECAY_LAMBDA = 0.023; // ln(2)/30 ≈ 30-day half life
const ROUTE_SAFETY_THRESHOLD_NORMAL = 0;
const ROUTE_SAFETY_THRESHOLD_NIGHT = 4.0;
const ROUTE_LIGHTING_THRESHOLD_NIGHT = 3.0;
const STOP_DETECTION_MS = 10 * 60 * 1000; // 10 minutes
const DEVIATION_THRESHOLD_M = 150;
const REVIEW_BATCH_INTERVAL_MS = 60 * 1000;

// ─── STATE ──────────────────────────────────────────────────────────
const state = {
  mode: 'normal', // 'normal' | 'night'
  routes: [],
  selectedRouteIndex: 0,
  isNavigating: false,
  buddyActive: false,
  buddyStartTime: null,
  buddyTimerInterval: null,
  stopTimeout: null,
  reviewQueue: [],
  pendingCountdown: null,
  pendingOkayTimeout: null,
  voiceSosEnabled: false,
  sidebarOpen: false,
  activeFilter: 'all',
};

// ─── MOCK DATA ───────────────────────────────────────────────────────
const MOCK_SEGMENTS = [
  {
    id: 'seg_001', name: 'MG Road', length: 800,
    reviews: [
      { isSafe: true, hasLighting: true, hasCrowd: true, travelWeight: 1.0, daysAgo: 2 },
      { isSafe: true, hasLighting: true, hasCrowd: true, travelWeight: 0.8, daysAgo: 8 },
      { isSafe: false, hasLighting: false, hasCrowd: false, travelWeight: 0.6, daysAgo: 45 },
    ],
    roadType: 'primary', policeNearby: 2,
  },
  {
    id: 'seg_002', name: 'Brigade Road', length: 600,
    reviews: [
      { isSafe: true, hasLighting: true, hasCrowd: true, travelWeight: 1.0, daysAgo: 1 },
      { isSafe: true, hasLighting: true, hasCrowd: false, travelWeight: 0.5, daysAgo: 15 },
    ],
    roadType: 'secondary', policeNearby: 1,
  },
  {
    id: 'seg_003', name: 'Residency Road', length: 400,
    reviews: [
      { isSafe: true, hasLighting: true, hasCrowd: true, travelWeight: 1.0, daysAgo: 3 },
    ],
    roadType: 'primary', policeNearby: 1,
  },
  {
    id: 'seg_004', name: 'Cubbon Park Lane', length: 500,
    reviews: [
      { isSafe: false, hasLighting: false, hasCrowd: false, travelWeight: 1.0, daysAgo: 5 },
      { isSafe: false, hasLighting: false, hasCrowd: false, travelWeight: 0.8, daysAgo: 12 },
    ],
    roadType: 'footway', policeNearby: 0,
  },
  {
    id: 'seg_005', name: 'Kasturba Road', length: 700,
    reviews: [
      { isSafe: true, hasLighting: false, hasCrowd: false, travelWeight: 0.7, daysAgo: 20 },
      { isSafe: true, hasLighting: true, hasCrowd: false, travelWeight: 0.5, daysAgo: 40 },
    ],
    roadType: 'residential', policeNearby: 0,
  },
];

const ROAD_TYPE_BONUS = {
  primary: 1.5, secondary: 1.0, residential: 0, footway: -1.5, path: -2.0, default: 0,
};

const MOCK_ROUTES = [
  {
    id: 'route_001',
    name: 'Safest Route',
    type: 'safe',
    segments: [MOCK_SEGMENTS[0], MOCK_SEGMENTS[1], MOCK_SEGMENTS[2]],
    distanceKm: 3.2,
    durationMin: 14,
    svgPath: 'M 80 400 C 80 400 150 320 200 260 S 300 140 350 100',
  },
  {
    id: 'route_002',
    name: 'Balanced Route',
    type: 'medium',
    segments: [MOCK_SEGMENTS[0], MOCK_SEGMENTS[4], MOCK_SEGMENTS[2]],
    distanceKm: 2.7,
    durationMin: 11,
    svgPath: 'M 80 400 C 80 400 200 300 280 220 S 360 150 450 100',
  },
  {
    id: 'route_003',
    name: 'Fastest Route',
    type: 'fast',
    segments: [MOCK_SEGMENTS[3], MOCK_SEGMENTS[4]],
    distanceKm: 2.1,
    durationMin: 9,
    svgPath: 'M 80 400 C 80 400 200 350 350 280 S 500 180 580 100',
  },
];

// ─── SCORING ENGINE ─────────────────────────────────────────────────
function computeFreshnessWeight(daysAgo) {
  return Math.exp(-DECAY_LAMBDA * daysAgo);
}

function computeSegmentScore(segment) {
  const reviews = segment.reviews;
  if (!reviews || reviews.length === 0) {
    return { safety: 5.0, lighting: 5.0, crowd: 5.0 };
  }

  let wSafetySum = 0, wLightingSum = 0, wCrowdSum = 0, wTotal = 0;

  for (const r of reviews) {
    const freshness = computeFreshnessWeight(r.daysAgo);
    const w = r.travelWeight * freshness;
    wSafetySum += (r.isSafe ? 1 : 0) * w;
    wLightingSum += (r.hasLighting ? 1 : 0) * w;
    wCrowdSum += (r.hasCrowd ? 1 : 0) * w;
    wTotal += w;
  }

  if (wTotal === 0) return { safety: 5.0, lighting: 5.0, crowd: 5.0 };

  const roadBonus = (ROAD_TYPE_BONUS[segment.roadType] || 0);
  return {
    safety: clamp((wSafetySum / wTotal) * 10 + roadBonus * 0.5, 0, 10),
    lighting: clamp((wLightingSum / wTotal) * 10 + roadBonus * 0.3, 0, 10),
    crowd: clamp((wCrowdSum / wTotal) * 10, 0, 10),
  };
}

function computeRouteScore(route, mode) {
  const segScores = route.segments.map(s => ({
    score: computeSegmentScore(s),
    length: s.length,
    policeNearby: s.policeNearby || 0,
  }));

  const totalLength = segScores.reduce((sum, s) => sum + s.length, 0);

  // Length-weighted averages
  const safety = segScores.reduce((sum, s) => sum + s.score.safety * s.length, 0) / totalLength;
  const lighting = segScores.reduce((sum, s) => sum + s.score.lighting * s.length, 0) / totalLength;
  const crowd = segScores.reduce((sum, s) => sum + s.score.crowd * s.length, 0) / totalLength;

  // Police bonus
  const totalPolice = segScores.reduce((sum, s) => sum + s.policeNearby, 0);
  const policeBonus = clamp((totalPolice / 3), 0, 1) * 10;

  // Final weighted score
  let finalScore;
  if (mode === 'night') {
    // Night mode: prioritize lighting more
    finalScore = (0.35 * safety) + (0.40 * lighting) + (0.15 * crowd) + (0.10 * policeBonus);
  } else {
    // Normal mode
    finalScore = (0.40 * safety) + (0.30 * lighting) + (0.20 * crowd) + (0.10 * policeBonus);
  }

  return {
    safety: parseFloat(safety.toFixed(1)),
    lighting: parseFloat(lighting.toFixed(1)),
    crowd: parseFloat(crowd.toFixed(1)),
    police: totalPolice,
    finalScore: parseFloat(finalScore.toFixed(1)),
    isNightSafe: safety >= ROUTE_SAFETY_THRESHOLD_NIGHT && lighting >= ROUTE_LIGHTING_THRESHOLD_NIGHT,
  };
}

function computeAllRoutes(mode) {
  let routes = MOCK_ROUTES.map(r => ({
    ...r,
    scores: computeRouteScore(r, mode),
  }));

  // Night mode filtering
  if (mode === 'night') {
    routes = routes.filter(r =>
      r.scores.safety >= ROUTE_SAFETY_THRESHOLD_NIGHT &&
      r.scores.lighting >= ROUTE_LIGHTING_THRESHOLD_NIGHT
    );
  }

  // Sort by final score
  routes.sort((a, b) => b.scores.finalScore - a.scores.finalScore);
  return routes;
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

// ─── DOM HELPERS ─────────────────────────────────────────────────────
function $id(id) { return document.getElementById(id); }
function $qs(sel) { return document.querySelector(sel); }
function $qsa(sel) { return document.querySelectorAll(sel); }

function showModal(overlayId) {
  const el = $id(overlayId);
  if (el) {
    el.classList.remove('hidden');
    el.classList.add('center');
  }
}

function hideModal(overlayId) {
  const el = $id(overlayId);
  if (el) el.classList.add('hidden');
}

function toast(msg, type = 'info', icon = '💬') {
  const tc = $id('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${msg}</span>`;
  tc.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

// ─── SCORE COLOUR ────────────────────────────────────────────────────
function scoreColor(val) {
  if (val >= 7.5) return { text: 'safe-text', fill: 'fill-safe' };
  if (val >= 5.0) return { text: 'warn-text', fill: 'fill-warning' };
  return { text: 'danger-text', fill: 'fill-danger' };
}

// ─── ROUTE CARDS ─────────────────────────────────────────────────────
function renderRouteCards(routes) {
  const list = $id('routes-list');
  list.innerHTML = '';

  if (routes.length === 0) {
    list.innerHTML = `
      <div style="text-align:center; padding:2rem; color:var(--text-muted)">
        <div style="font-size:2.5rem; margin-bottom:0.5rem">🌙</div>
        <p style="font-size:0.9rem">No routes meet the Night Mode safety threshold.<br>Try a different destination.</p>
      </div>`;
    $id('route-count').textContent = '0 routes';
    return;
  }

  $id('route-count').textContent = `${routes.length} route${routes.length > 1 ? 's' : ''}`;

  routes.forEach((route, i) => {
    // Guard: always ensure scores exist before rendering
    if (!route.scores) {
      route.scores = { safety: 5.0, lighting: 5.0, crowd: 5.0, police: 0, finalScore: 5.0, isNightSafe: false };
    }

    const scores = route.scores;
    const sc = scoreColor(scores.safety);
    const lc = scoreColor(scores.lighting);
    const cc = scoreColor(scores.crowd);
    const delay = i * 80;

    const typeClass = `card-${route.type}`;
    const badgeClass = route.type === 'safe' ? 'badge-safe' : route.type === 'medium' ? 'badge-medium' : 'badge-fast';
    const badgeLabel = route.type === 'safe' ? '🛡️ Safest' : route.type === 'medium' ? '⚖️ Balanced' : '⚡ Fastest';

    const nightSafeTag = state.mode === 'night' && route.scores.isNightSafe
      ? `<span class="night-safe-tag">🌙 Night Safe</span>` : '';

    const card = document.createElement('div');
    card.className = `route-card ${typeClass}${i === state.selectedRouteIndex ? ' selected' : ''}`;
    card.style.animationDelay = `${delay}ms`;
    card.dataset.routeIndex = i;

    card.innerHTML = `
      <div class="route-card-header">
        <span class="route-badge ${badgeClass}">${badgeLabel}</span>
        <div class="route-meta" style="display:flex;align-items:center;gap:0.5rem">
          ${nightSafeTag}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${route.durationMin} min
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12l18-6-6 18-3-9-9-3z"/></svg>${route.distanceKm} km
        </div>
      </div>

      <div class="route-scores">
        <div class="score-item">
          <span class="score-label">Safety</span>
          <div class="score-value-wrap">
            <span class="score-value ${sc.text}">${scores.safety}</span>
            <span class="score-max">/10</span>
          </div>
          <div class="score-bar"><div class="score-fill ${sc.fill}" style="width:${scores.safety * 10}%"></div></div>
        </div>

        <div class="score-item">
          <span class="score-label">Lighting</span>
          <div class="score-value-wrap">
            <span class="score-value ${lc.text}">${scores.lighting}</span>
            <span class="score-max">/10</span>
          </div>
          <div class="score-bar"><div class="score-fill ${lc.fill}" style="width:${scores.lighting * 10}%"></div></div>
        </div>

        <div class="score-item">
          <span class="score-label">Crowd</span>
          <div class="score-value-wrap">
            <span class="score-value ${cc.text}">${scores.crowd}</span>
            <span class="score-max">/10</span>
          </div>
          <div class="score-bar"><div class="score-fill ${cc.fill}" style="width:${scores.crowd * 10}%"></div></div>
        </div>

        <div class="score-item">
          <span class="score-label">Score</span>
          <div class="score-value-wrap">
            <span class="score-value blue-text">${scores.finalScore}</span>
            <span class="score-max">/10</span>
          </div>
          <div class="score-bar"><div class="score-fill fill-blue" style="width:${scores.finalScore * 10}%"></div></div>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
        <div class="police-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L3 7v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7z"/>
          </svg>
          ${scores.police} police station${scores.police !== 1 ? 's' : ''} nearby
        </div>
        ${route.type === 'safe' ? '<span style="font-size:0.75rem;color:var(--safe-green)">✓ Recommended</span>' : ''}
      </div>

      <button class="start-nav-btn" data-route-index="${i}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
        Start Navigation
      </button>
    `;

    list.appendChild(card);
  });

  // Animate route SVG paths
  animateRoutePaths(routes);
}

// ─── MAP SVG ANIMATION ───────────────────────────────────────────────
function animateRoutePaths(routes) {
  const paths = ['route-path-1', 'route-path-2', 'route-path-3'];
  const routeDefs = MOCK_ROUTES; // always show all paths, colour by score

  paths.forEach((pathId, i) => {
    const el = $id(pathId);
    if (!el) return;

    const routeDef = i < routeDefs.length ? routeDefs[i] : null;
    if (!routeDef) { el.setAttribute('d', ''); return; }

    el.setAttribute('d', routeDef.svgPath);

    // Reset animation
    el.style.strokeDashoffset = '1000';

    // Determine if this route is in filtered set
    const isVisible = routes.some(r => r.id === routeDef.id);

    el.classList.remove('selected', 'dimmed');
    if (!isVisible) {
      el.classList.add('dimmed');
    } else if (routes[0]?.id === routeDef.id) {
      el.classList.add('selected');
    }

    setTimeout(() => {
      el.style.strokeDashoffset = '0';
    }, 100 + i * 200);
  });

  // Show/hide pins (only present in fallback/mock map mode — safe to skip with Google Maps)
  $id('origin-pin')?.style && ($id('origin-pin').style.display = 'block');
  $id('dest-pin')?.style   && ($id('dest-pin').style.display   = 'block');
  if ($id('origin-pin')) {
    $id('origin-pin').style.left = '10%';
    $id('origin-pin').style.top  = '82%';
  }
  if ($id('dest-pin')) {
    $id('dest-pin').style.left = '52%';
    $id('dest-pin').style.top  = '20%';
  }

  // Hide placeholder text
  $qs('.map-overlay-text')?.classList.add('hidden');
}

// ─── ROUTE SEARCH ────────────────────────────────────────────────────
async function triggerRouteSearch(destName, destLocation) {
  const dest = destName || $id('dest-input').value.trim();
  if (!dest) return;

  toast('Finding safest routes…', 'info', '🔍');

  // Try real Google Maps routes first
  if (window.SathiMaps && destLocation) {
    try {
      const origin = window.SathiMaps.getState().currentLocation
        || { lat: 12.9716, lng: 77.5946 }; // Bengaluru fallback

      const routes = await window.SathiMaps.fetchRealRoutes(origin, destLocation, state.mode);

      state.routes = routes;
      renderRouteCards(routes);
      openRoutesPanel();

      const count = routes.length;
      const modeLabel = state.mode === 'night' ? ' (Night Mode filtered)' : '';
      toast(`${count} safe route${count !== 1 ? 's' : ''} found${modeLabel}`, 'success', '✅');
      $id('clear-dest-btn').classList.remove('hidden');
      return;
    } catch (err) {
      console.warn('Google Maps routes failed, falling back to demo:', err.message);
      toast('Using demo routes — Maps API loading', 'warn', '📡');
    }
  }

  // Fallback: mock routes (when Maps not loaded or no location selected)
  setTimeout(() => {
    state.routes = computeAllRoutes(state.mode);
    renderRouteCards(state.routes);
    openRoutesPanel();

    const count = state.routes.length;
    const modeLabel = state.mode === 'night' ? ' (Night Mode filtered)' : '';
    toast(`${count} safe route${count !== 1 ? 's' : ''} found${modeLabel}`, 'success', '✅');
    $id('clear-dest-btn').classList.remove('hidden');
  }, 800);
}

function openRoutesPanel() {
  window._sathi_selectedIdx = state.selectedRouteIndex || 0;
  $id('routes-panel').classList.add('open');
}

function closeRoutesPanel() {
  $id('routes-panel').classList.remove('open');
}

// ─── NIGHT MODE ──────────────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('night-mode', mode === 'night');

  // Update buttons
  $qsa('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Re-compute if routes are loaded
  if (state.routes.length > 0) {
    state.routes = computeAllRoutes(mode);
    renderRouteCards(state.routes);

    const nightMsg = mode === 'night'
      ? 'Night Mode on — prioritising lit, safe roads 🌙'
      : 'Normal Mode — showing all routes ☀️';
    toast(nightMsg, mode === 'night' ? 'warn' : 'info',
      mode === 'night' ? '🌙' : '☀️');
  }
}

// ─── NAVIGATION START ─────────────────────────────────────────────────
function startNavigation(routeIndex) {
  const route = state.routes[routeIndex];
  if (!route) return;

  state.isNavigating = true;
  state.selectedRouteIndex = routeIndex;

  $id('nav-active-view').classList.remove('hidden');
  $id('search-panel').classList.add('hidden');
  $id('routes-panel').classList.remove('open');
  $id('bottom-nav').classList.add('hidden');
  $id('top-bar').classList.add('hidden');

  // Support both Google Maps routes (.steps) and mock routes (.segments)
  const firstStep = route.steps?.[0] || route.segments?.[0];
  const streetName = firstStep?.html_instructions
    ? firstStep.html_instructions.replace(/<[^>]+>/g, '')   // strip HTML tags from Maps
    : (firstStep?.name || route.summary || route.name || 'Starting route');

  // Populate nav info
  $id('street-name').textContent = streetName;
  $id('eta').textContent = `${route.durationMin} min`;
  $id('remaining-dist').textContent = `${route.distanceKm} km`;

  // Set arrival time
  const now = new Date();
  now.setMinutes(now.getMinutes() + parseInt(route.durationMin, 10) || 0);
  $id('arrival-time').textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  // Highlight route on Google Map if available
  if (window.SathiMaps) {
    window.SathiMaps.highlightRoute(routeIndex);
  }

  startTravelBuddy();
  toast(`Navigating via ${route.name || route.summary || 'selected route'}`, 'success', '🧭');
}

function endNavigation() {
  state.isNavigating = false;
  stopTravelBuddy();
  flushOnNavEnd(); // submit any pending reviews immediately

  $id('nav-active-view').classList.add('hidden');
  $id('search-panel').classList.remove('hidden');
  $id('bottom-nav').classList.remove('hidden');
  $id('top-bar').classList.remove('hidden');

  toast('Navigation ended. Stay safe! 🛡️', 'success', '✅');

  // Prompt for feedback
  setTimeout(() => {
    toast('Share your journey feedback to help others', 'info', '📝');
  }, 2000);
}

function openInGoogleMaps() {
  const route = state.routes[state.selectedRouteIndex];
  let originStr = '';
  let destStr = '';
  
  if (window.SathiMaps) {
    const sathiState = window.SathiMaps.getState();
    if (sathiState.currentLocation) {
      originStr = `${sathiState.currentLocation.lat},${sathiState.currentLocation.lng}`;
    }
    if (sathiState.destLocation) {
      destStr = `${sathiState.destLocation.lat},${sathiState.destLocation.lng}`;
    }
  }

  // Fallback to name if lat,lng not available
  if (!destStr) {
    destStr = encodeURIComponent($id('dest-input').value.trim() || 'Bengaluru');
  }

  let mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destStr}&travelmode=driving`;
  
  if (originStr) {
    mapsUrl += `&origin=${originStr}`;
  }

  window.open(mapsUrl, '_blank');
  toast('Opening Google Maps API Navigation...', 'info', '🗺️');
}

// ─── TRAVEL BUDDY ─────────────────────────────────────────────────────
function startTravelBuddy() {
  state.buddyActive = true;
  state.buddyStartTime = Date.now();
  $id('ind-location').classList.add('active');

  // Timer display
  state.buddyTimerInterval = setInterval(() => {
    const elapsed = Date.now() - state.buddyStartTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    $id('buddy-time').textContent = `${mins}:${String(secs).padStart(2, '0')}`;
  }, 1000);

  // Stop detection (simulated after delay in demo)
  scheduleStopDetection();
}

function stopTravelBuddy() {
  state.buddyActive = false;
  clearInterval(state.buddyTimerInterval);
  clearTimeout(state.stopTimeout);
  clearTimeout(state.pendingOkayTimeout);
}

function scheduleStopDetection() {
  // For demo: trigger the "Are you okay" after 30 seconds instead of 10 min
  state.stopTimeout = setTimeout(() => {
    if (state.isNavigating && state.buddyActive) {
      showOkayCheck();
    }
  }, 30000);
}

function showOkayCheck() {
  showModal('okay-modal-overlay');
  toast('Safety check triggered — stationary for 10+ minutes', 'warn', '⚠️');

  // Auto-SOS if no response in 2 minutes (demo: 30s)
  state.pendingOkayTimeout = setTimeout(() => {
    const modal = $id('okay-modal-overlay');
    if (!modal.classList.contains('hidden')) {
      hideModal('okay-modal-overlay');
      triggerSOS('stop_detection');
    }
  }, 30000);
}

// ─── SOS SYSTEM ──────────────────────────────────────────────────────
function openSOSModal() {
  showModal('sos-modal-overlay');
  $id('sos-countdown').classList.add('hidden');
  $id('sos-action-btns').classList.remove('hidden');
}

function confirmSOS() {
  $id('sos-action-btns').classList.add('hidden');
  $id('sos-countdown').classList.remove('hidden');

  let count = 5;
  $id('countdown-num').textContent = count;
  $id('countdown-sec').textContent = count;

  const circle = $id('countdown-circle');
  const circumference = 163;

  const interval = setInterval(() => {
    count--;
    $id('countdown-num').textContent = count;
    $id('countdown-sec').textContent = count;

    // Animate circle
    const offset = circumference - (count / 5) * circumference;
    circle.style.strokeDashoffset = offset;

    if (count <= 0) {
      clearInterval(interval);
      hideModal('sos-modal-overlay');
      triggerSOS('manual');
    }
  }, 1000);

  state.pendingCountdown = interval;
}

function triggerSOS(trigger = 'manual') {
  hideModal('sos-modal-overlay');
  hideModal('okay-modal-overlay');

  toast('🆘 SOS Alert Sent! Emergency contacts notified.', 'danger', '🚨');
  toast('Amma & Nanna have been notified with your live location', 'danger', '📍');

  // Call real backend — gets GPS from browser, sends SMS+email
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const result = await window.SathiAPI?.triggerSOSAlert({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            trigger,
            routeId: state.routes[state.selectedRouteIndex]?.id || null,
          });
          if (result?.notifiedCount) {
            toast(`✅ ${result.notifiedCount} contact(s) notified via SMS & email`, 'success', '📨');
          }
        } catch (err) {
          console.warn('SOS backend call failed (contacts may still be notified via WS):', err.message);
        }
      },
      () => {
        // GPS denied — still send without location
        window.SathiAPI?.triggerSOSAlert({ lat: 0, lng: 0, trigger }).catch(() => { });
      }
    );
  }

  // Visual feedback on nav strip
  if (state.isNavigating) {
    $id('ind-safety').style.color = 'var(--danger-red)';
    $id('ind-safety').style.borderColor = 'var(--danger-red)';
  }
}

// ─── FEEDBACK SYSTEM ─────────────────────────────────────────────────
// Maps feedback button type → review fields
const FEEDBACK_MAP = {
  safe: { isSafe: true, hasLighting: null, hasCrowd: null },
  unsafe: { isSafe: false, hasLighting: null, hasCrowd: null },
  lit: { isSafe: null, hasLighting: true, hasCrowd: null },
  dark: { isSafe: null, hasLighting: false, hasCrowd: null },
  crowd: { isSafe: null, hasLighting: null, hasCrowd: true },
};

function handleFeedback(type) {
  const btn = $id(`fb-${type}`);
  if (!btn) return;

  const wasSelected = btn.classList.contains('selected');

  // Toggle exclusive within pairs (safe↔unsafe, lit↔dark)
  const pairs = { safe: 'unsafe', unsafe: 'safe', lit: 'dark', dark: 'lit' };
  if (pairs[type]) {
    $id(`fb-${pairs[type]}`)?.classList.remove('selected');
  }
  btn.classList.toggle('selected', !wasSelected);

  if (wasSelected) return; // deselected — don't queue again

  // Build review from current route's first segment
  const route = state.routes[state.selectedRouteIndex];
  const segment = route?.steps?.[0] || route?.segments?.[0];
  const segmentId = segment?.id || null;

  // Get current GPS position for the review
  const getLocationAndQueue = (lat, lng) => {
    const fb = FEEDBACK_MAP[type];
    if (!fb) return;

    // Build complete review (merge with any existing pending for this segment)
    const existing = state.reviewQueue.find(r => r.segmentId === segmentId && !r.submitted);
    if (existing) {
      // Merge into existing queued review for this segment
      if (fb.isSafe !== null) existing.isSafe = fb.isSafe;
      if (fb.hasLighting !== null) existing.hasLighting = fb.hasLighting;
      if (fb.hasCrowd !== null) existing.hasCrowd = fb.hasCrowd;
    } else {
      state.reviewQueue.push({
        segmentId: segmentId || 'unknown',
        isSafe: fb.isSafe ?? true,
        hasLighting: fb.hasLighting ?? true,
        hasCrowd: fb.hasCrowd ?? false,
        travelWeight: 1.0,
        timestamp: Date.now(),
        lat, lng,
        submitted: false,
      });
    }

    const msgs = {
      safe: '✅ Marked as safe — thank you!',
      unsafe: '⚠️ Unsafe area noted — helps others',
      lit: '💡 Street light confirmed',
      dark: '🌑 Dark area noted',
      crowd: '👥 Crowd confirmed',
    };
    toast(msgs[type] || 'Feedback recorded', 'success', '📝');
  };

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => getLocationAndQueue(pos.coords.latitude, pos.coords.longitude),
      () => getLocationAndQueue(null, null),
      { timeout: 3000, maximumAge: 30000 }
    );
  } else {
    getLocationAndQueue(null, null);
  }
}

// ─── REVIEW BATCH FLUSH ───────────────────────────────────────────────
// Automatically submits pending reviews to backend every 60 seconds.
async function flushReviewQueue() {
  const pending = state.reviewQueue.filter(r => !r.submitted && r.segmentId !== 'unknown');
  if (pending.length === 0) return;

  try {
    await window.SathiAPI?.submitReviewBatch(pending.map(r => ({
      segmentId: r.segmentId,
      isSafe: r.isSafe,
      hasLighting: r.hasLighting,
      hasCrowd: r.hasCrowd,
      travelWeight: r.travelWeight,
      timestamp: r.timestamp,
    })));

    // Mark as submitted
    pending.forEach(r => { r.submitted = true; });
    console.log(`✅ Flushed ${pending.length} review(s) to backend`);
  } catch (err) {
    console.warn('Review batch flush failed (will retry):', err.message);
  }
}

// Start the 60-second flush timer
setInterval(flushReviewQueue, 60 * 1000);
// Also flush when user ends navigation
function flushOnNavEnd() { flushReviewQueue(); }


// ─── OFFLINE DOWNLOAD SIMULATION ─────────────────────────────────────
function simulateDownload(regionCard, btn) {
  const progressDiv = document.createElement('div');
  progressDiv.className = 'download-progress';
  progressDiv.innerHTML = '<div class="download-fill" id="dl-fill"></div>';
  regionCard.appendChild(progressDiv);

  btn.disabled = true;
  btn.textContent = 'Downloading…';

  let progress = 0;
  const fill = progressDiv.querySelector('.download-fill');
  const interval = setInterval(() => {
    progress += Math.random() * 8 + 2;
    if (progress >= 100) {
      progress = 100;
      clearInterval(interval);
      fill.style.width = '100%';
      btn.textContent = 'Downloaded ✓';
      btn.style.color = 'var(--safe-green)';
      regionCard.classList.add('downloaded');
      progressDiv.remove();
      toast(`Maps downloaded! Offline navigation ready 📴`, 'success', '✅');
    } else {
      fill.style.width = `${progress}%`;
    }
  }, 150);
}

// ─── TIME-OF-DAY CHART ────────────────────────────────────────────────
function renderTimeChart() {
  const chart = $id('time-chart');
  if (!chart) return;

  const hours = [
    { label: '6AM', safe: 0.9 }, { label: '9AM', safe: 0.85 },
    { label: '12PM', safe: 0.8 }, { label: '3PM', safe: 0.75 },
    { label: '6PM', safe: 0.7 }, { label: '9PM', safe: 0.5 },
    { label: '12AM', safe: 0.3 }, { label: '3AM', safe: 0.25 },
  ];

  const maxH = 56;
  chart.innerHTML = hours.map(h => {
    const height = Math.round(h.safe * maxH);
    const color = h.safe >= 0.65 ? 'var(--safe-green)' : h.safe >= 0.4 ? 'var(--warn-yellow)' : 'var(--danger-red)';
    return `<div class="time-bar" style="height:${height}px;background:${color};opacity:0.8" data-label="${h.label}: ${Math.round(h.safe * 10)}/10 safety" title="${h.label}"></div>`;
  }).join('');
}

// ─── SIDEBAR ─────────────────────────────────────────────────────────
function openSidebar() {
  state.sidebarOpen = true;
  $id('sidebar').classList.add('open');
  $id('sidebar-overlay').classList.add('open');
}

function closeSidebar() {
  state.sidebarOpen = false;
  $id('sidebar').classList.remove('open');
  $id('sidebar-overlay').classList.remove('open');
}

// ─── FILTER CHIPS ─────────────────────────────────────────────────────
function applyFilter(filter) {
  state.activeFilter = filter;

  $qsa('.chip').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === filter);
  });

  if (state.routes.length === 0) return;

  let filtered = state.routes;
  if (filter === 'safest') filtered = [...state.routes].sort((a, b) => b.scores.safety - a.scores.safety);
  if (filter === 'fastest') filtered = [...state.routes].sort((a, b) => a.durationMin - b.durationMin);
  if (filter === 'lit') filtered = [...state.routes].sort((a, b) => b.scores.lighting - a.scores.lighting);

  renderRouteCards(filtered);
}

// ─── VOICE SOS TOGGLE ────────────────────────────────────────────────
function toggleVoiceSos(toggle, enable) {
  toggle.classList.toggle('active', enable);
  state.voiceSosEnabled = enable;

  if (enable) {
    toast('Voice SOS enabled — say "Help Me" anytime during navigation', 'info', '🎤');
    // In production: initialize Web Speech API recognition
  }
}

// ─── SWAP INPUT VALUES ────────────────────────────────────────────────
function swapInputs() {
  const originEl = $id('origin-input');
  const destEl = $id('dest-input');
  const temp = originEl.value;
  originEl.value = destEl.value;
  destEl.value = temp;

  // Small animation
  originEl.style.transition = 'transform 0.2s ease';
  destEl.style.transition = 'transform 0.2s ease';
  originEl.style.transform = 'translateY(4px)';
  destEl.style.transform = 'translateY(-4px)';
  setTimeout(() => {
    originEl.style.transform = '';
    destEl.style.transform = '';
  }, 200);

  if (destEl.value) triggerRouteSearch();
}

// ─── SPLASH TRANSITION ────────────────────────────────────────────────
function hideSplash() {
  const splash = $id('splash-screen');
  const app = $id('app');
  splash.classList.add('fade-out');
  setTimeout(() => {
    splash.classList.add('hidden');
    app.classList.remove('hidden');
    app.style.animation = 'fadeSlideUp 0.5s ease';
  }, 600);
}

// ─── ADD CONTACT ──────────────────────────────────────────────────────
function addContact() {
  const name = $id('new-contact-name').value.trim();
  const phone = $id('new-contact-phone').value.trim();

  if (!name || !phone) {
    toast('Please enter name and phone number', 'warn', '⚠️');
    return;
  }

  const list = $id('contacts-list');
  const initial = name[0].toUpperCase();
  const card = document.createElement('div');
  card.className = 'contact-card';
  card.innerHTML = `
    <div class="contact-avatar">${initial}</div>
    <div class="contact-info">
      <span class="contact-name">${name}</span>
      <span class="contact-phone">${phone}</span>
    </div>
    <button class="icon-btn danger-subtle" onclick="this.closest('.contact-card').remove()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
    </button>
  `;
  list.appendChild(card);

  $id('new-contact-name').value = '';
  $id('new-contact-phone').value = '';

  toast(`${name} added as emergency contact ✅`, 'success', '👤');
}

// ─── KEYBOARD SHORTCUT ───────────────────────────────────────────────
function handleKeydown(e) {
  if (e.key === 'Escape') {
    closeSidebar();
    hideModal('sos-modal-overlay');
    hideModal('okay-modal-overlay');
    hideModal('contacts-modal-overlay');
    hideModal('offline-modal-overlay');
    hideModal('voice-modal-overlay');
    hideModal('report-modal-overlay');
  }
  if (e.key === 'Enter') {
    const dest = $id('dest-input');
    if (document.activeElement === dest && dest.value) {
      triggerRouteSearch();
    }
  }
}

// ─── MAIN EVENT SETUP ─────────────────────────────────────────────────
function initEventListeners() {
  // Splash → App
  // (handled in init)

  // Mode switcher
  $qsa('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Search
  $id('dest-input').addEventListener('keydown', e => {
    // Enter key: only triggers mock/fallback search (real search fires via Places autocomplete)
    if (e.key === 'Enter') triggerRouteSearch($id('dest-input').value.trim(), null);
  });

  $id('dest-input').addEventListener('input', () => {
    const val = $id('dest-input').value.trim();
    $id('clear-dest-btn').classList.toggle('hidden', !val);
    if (!val) {
      closeRoutesPanel();
      $qs('.map-overlay-text')?.classList.remove('hidden');
    }
  });

  $id('use-location-btn').addEventListener('click', () => {
    $id('origin-input').value = 'Current Location 📍';
    toast('Using your current location', 'info', '📍');
  });

  $id('clear-dest-btn').addEventListener('click', () => {
    $id('dest-input').value = '';
    $id('clear-dest-btn').classList.add('hidden');
    closeRoutesPanel();
    $qs('.map-overlay-text')?.classList.remove('hidden');
  });

  $id('swap-btn').addEventListener('click', swapInputs);

  // Filter chips
  $qsa('.chip').forEach(chip => {
    chip.addEventListener('click', () => applyFilter(chip.dataset.filter));
  });

  // Route card clicks (delegated)
  $id('routes-list').addEventListener('click', e => {
    const card = e.target.closest('.route-card');
    const startBtn = e.target.closest('.start-nav-btn');

    if (startBtn) {
      const idx = parseInt(startBtn.dataset.routeIndex, 10);
      startNavigation(idx);
      return;
    }

    if (card) {
      const idx = parseInt(card.dataset.routeIndex, 10);
      state.selectedRouteIndex = idx;
      window._sathi_selectedIdx = idx;  // used by sticky Start Navigation button
      $qsa('.route-card').forEach((c, i) => c.classList.toggle('selected', i === idx));

      // Highlight on Google Map
      if (window.SathiMaps) window.SathiMaps.highlightRoute(idx);

      // Highlight corresponding route path
      const pathIds = ['route-path-1', 'route-path-2', 'route-path-3'];
      const routes = state.routes;
      pathIds.forEach((pid, i) => {
        const el = $id(pid);
        if (!el) return;
        const matchesSelected = routes[idx] && MOCK_ROUTES[i]?.id === routes[idx].id;
        el.classList.toggle('selected', matchesSelected);
        el.classList.toggle('dimmed', !matchesSelected);
        if (matchesSelected) el.style.strokeWidth = '9';
        else el.style.strokeWidth = '6';
      });
    }
  });

  // End navigation
  $id('end-nav-btn').addEventListener('click', endNavigation);

  // Live feedback buttons
  $qsa('.feedback-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFeedback(btn.dataset.type));
  });

  // SOS button
  $id('sos-btn').addEventListener('click', openSOSModal);
  $id('sos-nav-btn').addEventListener('click', openSOSModal);
  $id('confirm-sos-btn').addEventListener('click', confirmSOS);
  $id('cancel-sos-btn').addEventListener('click', () => {
    if (state.pendingCountdown) clearInterval(state.pendingCountdown);
    hideModal('sos-modal-overlay');
  });

  // Okay check
  $id('okay-yes-btn').addEventListener('click', () => {
    clearTimeout(state.pendingOkayTimeout);
    hideModal('okay-modal-overlay');
    toast('Great! Journey continues safely', 'success', '✅');
    scheduleStopDetection();
  });

  $id('okay-timer-btn').addEventListener('click', () => {
    clearTimeout(state.pendingOkayTimeout);
    hideModal('okay-modal-overlay');
    toast('Timer set — check-in in 5 minutes', 'info', '⏱️');
    state.pendingOkayTimeout = setTimeout(() => {
      if (state.isNavigating) showOkayCheck();
    }, 5 * 60 * 1000);
  });

  $id('okay-sos-btn').addEventListener('click', () => {
    hideModal('okay-modal-overlay');
    triggerSOS('manual');
  });

  // Sidebar
  $id('menu-btn').addEventListener('click', openSidebar);
  $id('close-sidebar-btn').addEventListener('click', closeSidebar);
  $id('sidebar-overlay').addEventListener('click', closeSidebar);

  // Sidebar links → modals
  $id('open-emergency').addEventListener('click', e => {
    e.preventDefault();
    closeSidebar();
    showModal('contacts-modal-overlay');
  });

  $id('open-offline').addEventListener('click', e => {
    e.preventDefault();
    closeSidebar();
    showModal('offline-modal-overlay');
  });

  $id('open-safety-report').addEventListener('click', e => {
    e.preventDefault();
    closeSidebar();
    renderTimeChart();
    showModal('report-modal-overlay');
  });

  $id('open-voice-sos').addEventListener('click', e => {
    e.preventDefault();
    closeSidebar();
    showModal('voice-modal-overlay');
  });

  // Close modals
  $id('close-contacts-btn').addEventListener('click', () => hideModal('contacts-modal-overlay'));
  $id('close-offline-btn').addEventListener('click', () => hideModal('offline-modal-overlay'));
  $id('close-voice-btn').addEventListener('click', () => hideModal('voice-modal-overlay'));
  $id('close-report-btn').addEventListener('click', () => hideModal('report-modal-overlay'));

  // Modal overlays (click outside to close)
  ['contacts-modal-overlay', 'offline-modal-overlay', 'voice-modal-overlay', 'report-modal-overlay'].forEach(id => {
    $id(id).addEventListener('click', e => {
      if (e.target.id === id) hideModal(id);
    });
  });

  // Add contact
  $id('add-contact-btn').addEventListener('click', addContact);

  // Offline downloads
  $qsa('.download-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.region-card');
      simulateDownload(card, btn);
    });
  });

  // Voice toggles
  $id('voice-toggle').addEventListener('click', function () {
    const isActive = this.classList.contains('active');
    toggleVoiceSos(this, !isActive);
  });

  $id('nav-only-toggle').addEventListener('click', function () {
    this.classList.toggle('active');
  });

  // Bottom nav
  $qsa('.bottom-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $qsa('.bottom-nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (btn.dataset.view === 'report') {
        renderTimeChart();
        showModal('report-modal-overlay');
      }
      if (btn.dataset.view === 'buddy') {
        if (state.isNavigating) {
          toast('Travel Buddy is monitoring your journey', 'info', '🧍');
        } else {
          toast('Start a navigation to activate Travel Buddy', 'info', '🧍');
        }
      }
    });
  });

  // Profile
  $id('profile-btn').addEventListener('click', openSidebar);

  // Map controls
  $id('zoom-in').addEventListener('click', () => toast('Zoom in (Google Maps required)', 'info', '🗺️'));
  $id('zoom-out').addEventListener('click', () => toast('Zoom out (Google Maps required)', 'info', '🗺️'));
  $id('locate-btn').addEventListener('click', () => {
    $id('origin-input').value = 'Current Location 📍';
    toast('Location detected', 'success', '📍');
  });

  // Keyboard
  document.addEventListener('keydown', handleKeydown);

  // Quick demo: prefill and auto-search for visual impact
  setTimeout(() => {
    if (!$id('origin-input').value) {
      $id('origin-input').value = 'Current Location 📍';
    }
  }, 500);
}

// ─── MAPS CALLBACKS (called by maps.js) ─────────────────────────────
// Fired when user picks an origin from Places autocomplete
window.onOriginSelected = function (placeName, location) {
  $id('origin-input').value = placeName;
  // If destination is already set, trigger route search
  const destInput = $id('dest-input').value.trim();
  const destLocation = window.SathiMaps?.getState().destLocation;
  if (destInput && destLocation) {
    triggerRouteSearch(destInput, destLocation);
  }
};

// Fired when user picks a destination from Places autocomplete
window.onDestinationSelected = function (placeName, location) {
  $id('dest-input').value = placeName;
  $id('clear-dest-btn').classList.remove('hidden');
  triggerRouteSearch(placeName, location);
};

// Fired when Google Maps finishes loading
window.onMapsReady = function () {
  toast('Map loaded — search for a destination', 'success', '🗺️');
};

// ─── INIT ─────────────────────────────────────────────────────────────
function init() {
  // Show splash, hide after load
  setTimeout(hideSplash, 2600);

  // Wire up all events after DOM is ready
  initEventListeners();

  // Initial panel title
  $id('panel-title').textContent = 'Safe Routes Found';

  // Simulate GPS availability
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      () => toast('GPS location acquired', 'success', '📍'),
      () => toast('Using simulated location', 'warn', '📍'),
      { timeout: 3000 }
    );
  }

  // Check backend connection — shows status toast
  setTimeout(async () => {
    if (window.SathiAPI) {
      const alive = await window.SathiAPI.isBackendAlive();
      if (alive) {
        toast('Backend connected — live safety data active', 'success', '🔗');
      } else {
        toast('Running in demo mode — backend not reachable', 'info', '📡');
      }
    }
  }, 3000);
}

// ─── BOOT ─────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
