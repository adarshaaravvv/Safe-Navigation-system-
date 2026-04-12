/**
 * SATHI API CLIENT
 * Connects the frontend to the backend API at localhost:3001.
 * Falls back to mock data if the backend is unreachable.
 */

const API_BASE = 'http://localhost:3001';

/** Generic fetch wrapper with error handling and timeout */
async function apiFetch(path, options = {}) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  }
}

/** Check if backend is reachable */
async function isBackendAlive() {
  try {
    const data = await apiFetch('/health');
    return data?.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Fetch ranked safe routes between two coordinates.
 * @param {number} originLat  @param {number} originLng
 * @param {number} destLat    @param {number} destLng
 * @param {string} mode       'normal' | 'night'
 */
async function fetchRoutes(originLat, originLng, destLat, destLng, mode = 'normal') {
  const params = new URLSearchParams({
    origin_lat: originLat,
    origin_lng: originLng,
    dest_lat:   destLat,
    dest_lng:   destLng,
    mode,
  });
  return apiFetch(`/api/routes?${params}`);
}

/**
 * Submit a single safety review for a road segment.
 */
async function submitReview({ segmentId, isSafe, hasLighting, hasCrowd, travelWeight, lat, lng }) {
  return apiFetch('/api/reviews', {
    method: 'POST',
    body:   { segmentId, isSafe, hasLighting, hasCrowd, travelWeight, lat, lng },
  });
}

/**
 * Submit a batch of offline-queued reviews.
 * @param {Array} reviews
 */
async function submitReviewBatch(reviews) {
  return apiFetch('/api/reviews/batch', {
    method: 'POST',
    body:   { reviews },
  });
}

/**
 * Trigger SOS alert — sends SMS/email to emergency contacts.
 * @param {object} params { lat, lng, trigger, routeId }
 */
async function triggerSOSAlert({ lat, lng, trigger = 'manual', routeId = null }) {
  return apiFetch('/api/sos/trigger', {
    method: 'POST',
    body:   { lat, lng, trigger, routeId },
  });
}

/**
 * Trigger SOS alert directly — no auth required.
 * Accepts contacts from the frontend and fires Twilio SMS immediately.
 * @param {object} params { lat, lng, trigger, contacts, userName, routeDesc }
 */
async function sendDirectSOS({ lat, lng, trigger = 'manual', contacts, userName = '', routeDesc = '' }) {
  return apiFetch('/api/sos/send-direct', {
    method: 'POST',
    body:   { lat, lng, trigger, contacts, userName, routeDesc },
  });
}

/**
 * Fetch police stations near a GPS coordinate.
 * @param {number} lat @param {number} lng @param {number} radius metres
 */
async function fetchNearbyPolice(lat, lng, radius = 1000) {
  const params = new URLSearchParams({ lat, lng, radius });
  return apiFetch(`/api/police/nearby?${params}`);
}

/**
 * Get offline data bundle for a region (for IndexedDB storage).
 */
async function fetchOfflineBundle(lat, lng, radius = 10000) {
  const params = new URLSearchParams({ lat, lng, radius });
  return apiFetch(`/api/offline/bundle?${params}`);
}

/**
 * Register or sync user profile after Firebase Auth.
 */
async function registerUser({ firebaseUid, name, email, phone }) {
  return apiFetch('/api/auth/register', {
    method: 'POST',
    body:   { firebaseUid, name, email, phone },
  });
}

/**
 * Update emergency contacts list.
 */
async function updateEmergencyContacts(uid, contacts) {
  return apiFetch(`/api/auth/profile?uid=${uid}`, {
    method:  'PATCH',
    body:    { emergencyContacts: contacts },
  });
}

// Export for use in app.js
window.SathiAPI = {
  isBackendAlive,
  fetchRoutes,
  submitReview,
  submitReviewBatch,
  triggerSOSAlert,
  sendDirectSOS,
  fetchNearbyPolice,
  fetchOfflineBundle,
  registerUser,
  updateEmergencyContacts,
};
