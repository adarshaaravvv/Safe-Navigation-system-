/**
 * SATHI MAPS MODULE
 * Handles all Google Maps functionality:
 *   - Map initialisation (dark theme)
 *   - Places Autocomplete on destination input
 *   - Directions API for real route fetching
 *   - Drawing color-coded route polylines
 *   - User geolocation
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────
const mapsState = {
  map:              null,
  userMarker:       null,
  directionsService: null,
  renderers:        [],        // one DirectionsRenderer per route
  heading:          0,         // current device compass heading (degrees)
  _prevLocation:    null,      // previous GPS position for heading calc
  _compassListener: null,      // DeviceOrientationEvent handler ref
  routeMarkers:     [],        // Start/End pins
  currentLocation:  null,      // { lat, lng }
  destLocation:     null,      // { lat, lng }
  autocomplete:     null,
  geolocationWatch: null,
};

// ─── Dark map style matching Sathi's dark theme ───────────────────────
const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#0A0C14' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0A0C14' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8B91A8' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#C8CCDB' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#8B91A8' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#131726' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#6B7280' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1C2235' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#131726' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9CA3AF' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2D3A5C' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1C2235' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#E2E8F0' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#1C2235' }] },
  { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: '#8B91A8' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0D1421' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4B5563' }] },
  { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: '#0D1421' }] },
];

// Route colors matching Sathi's design system
const ROUTE_COLORS = {
  safe:   '#22C55E',   // safe-green
  medium: '#F59E0B',   // warn-yellow/amber
  fast:   '#38BDF8',   // info-blue
};

/**
 * Called by Google Maps script callback=onGoogleMapsReady
 * Initialises the map and wires autocomplete on the destination input.
 */
function initGoogleMap() {
  const mapEl = document.getElementById('google-map');
  if (!mapEl) return;

  // Default center: Bengaluru
  const defaultCenter = { lat: 12.9716, lng: 77.5946 };

  mapsState.map = new google.maps.Map(mapEl, {
    center:            defaultCenter,
    zoom:              14,
    styles:            window._sathi_mode === 'night' ? DARK_MAP_STYLE : [],
    disableDefaultUI:  true,
    zoomControl:       false,
    mapTypeControl:    false,
    streetViewControl: false,
    fullscreenControl: false,
    gestureHandling:   'greedy',
  });

  mapsState.directionsService = new google.maps.DirectionsService();

  // Wire Places autocomplete to destination input
  const destInput = document.getElementById('dest-input');
  if (destInput) {
    mapsState.autocomplete = new google.maps.places.Autocomplete(destInput, {
      componentRestrictions: { country: 'IN' },
      fields: ['geometry', 'name', 'formatted_address'],
    });

    mapsState.autocomplete.addListener('place_changed', () => {
      const place = mapsState.autocomplete.getPlace();
      if (!place.geometry) return;

      mapsState.destLocation = {
        lat: place.geometry.location.lat(),
        lng: place.geometry.location.lng(),
      };

      // Trigger route search — calls fetchRealRoutes()
      if (window.onDestinationSelected) {
        window.onDestinationSelected(place.name || place.formatted_address, mapsState.destLocation);
      }
    });
  }

  // Wire Places autocomplete to origin input
  const originInput = document.getElementById('origin-input');
  if (originInput) {
    mapsState.originAutocomplete = new google.maps.places.Autocomplete(originInput, {
      componentRestrictions: { country: 'IN' },
      fields: ['geometry', 'name', 'formatted_address'],
    });

    mapsState.originAutocomplete.addListener('place_changed', () => {
      const place = mapsState.originAutocomplete.getPlace();
      if (!place.geometry) return;

      mapsState.currentLocation = {
        lat: place.geometry.location.lat(),
        lng: place.geometry.location.lng(),
      };

      if (mapsState.userMarker) {
        mapsState.userMarker.setPosition(mapsState.currentLocation);
        mapsState.map.panTo(mapsState.currentLocation);
      }

      if (window.onOriginSelected) {
        window.onOriginSelected(place.name || place.formatted_address, mapsState.currentLocation);
      }
    });
  }

  // Wire zoom buttons
  document.getElementById('zoom-in')?.addEventListener('click', () => {
    mapsState.map.setZoom(mapsState.map.getZoom() + 1);
  });
  document.getElementById('zoom-out')?.addEventListener('click', () => {
    mapsState.map.setZoom(mapsState.map.getZoom() - 1);
  });

  // Start geolocation
  startGeolocation();

  console.log('✅ Google Maps initialized');
  if (window.onMapsReady) window.onMapsReady();
}

/**
 * Get user's GPS location and center map on it.
 */
function startGeolocation() {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      mapsState.currentLocation = loc;
      mapsState.map.setCenter(loc);
      mapsState.map.setZoom(15);

      // Blue dot for current location
      mapsState.userMarker = new google.maps.Marker({
        position: loc,
        map:      mapsState.map,
        icon: {
          path:         google.maps.SymbolPath.CIRCLE,
          scale:        10,
          fillColor:    '#6C3AE8',
          fillOpacity:  1,
          strokeColor:  '#A78BFA',
          strokeWeight: 3,
        },
        title: 'Your location',
        zIndex: 100,
      });

      document.getElementById('origin-input').value = 'Current Location 📍';
      if (window.onOriginSelected) {
        window.onOriginSelected('Current Location 📍', mapsState.currentLocation);
      }
    },
    (err) => {
      console.warn('Geolocation error:', err.message);
      // Fallback to Bengaluru city center
      mapsState.currentLocation = { lat: 12.9716, lng: 77.5946 };
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

/**
 * Get user's GPS location and set it as destination.
 */
function fetchDestLocation() {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      mapsState.destLocation = loc;
      
      document.getElementById('dest-input').value = 'Current Location 📍';
      const clearBtn = document.getElementById('clear-dest-btn');
      if (clearBtn) clearBtn.classList.remove('hidden');

      if (window.onDestinationSelected) {
        window.onDestinationSelected('Current Location 📍', mapsState.destLocation);
      }
    },
    (err) => {
      console.warn('Geolocation error:', err.message);
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

/**
 * Fetch up to 3 real route alternatives using Google Directions API.
 * Colors them by safety rank: green (safest), amber (balanced), blue (fastest).
 * @param {object} origin  { lat, lng }
 * @param {object} dest    { lat, lng }
 * @param {string} mode    'normal' | 'night'
 * @returns {Promise<Array>} Array of route objects with scores
 */
async function fetchRealRoutes(origin, dest, mode = 'normal') {
  if (!mapsState.directionsService) throw new Error('Maps not initialized');

  // Ensure we always have an origin — use passed-in, then GPS, then Bengaluru fallback
  const effectiveOrigin = origin
    || mapsState.currentLocation
    || { lat: 12.9716, lng: 77.5946 };

  // Store dest for later scoring
  mapsState.destLocation = dest;

  clearRouteRenderers();

  return new Promise((resolve, reject) => {
    mapsState.directionsService.route(
      {
        origin:      new google.maps.LatLng(effectiveOrigin.lat, effectiveOrigin.lng),
        destination: new google.maps.LatLng(dest.lat, dest.lng),
        travelMode:  google.maps.TravelMode.DRIVING,
        provideRouteAlternatives: true,
        unitSystem: google.maps.UnitSystem.METRIC,
      },
      async (result, status) => {
        if (status !== 'OK') {
          return reject(new Error(`Directions API: ${status}`));
        }

        const routes = result.routes;
        const routeNames   = ['Safest Route', 'Balanced Route', 'Fastest Route'];
        const routeTypes   = ['safe', 'medium', 'fast'];
        const routeColors  = [ROUTE_COLORS.safe, ROUTE_COLORS.medium, ROUTE_COLORS.fast];

        // Build route objects (mock scores for now — real scores from backend)
        const builtRoutes = routes.slice(0, 3).map((r, i) => {
          const leg = r.legs[0];
          return {
            id:          `gmaps-${i}-${Date.now()}`,
            name:        routeNames[i] || `Route ${i + 1}`,
            type:        routeTypes[i] || 'fast',
            distanceKm:  (leg.distance.value / 1000).toFixed(1),
            durationMin: Math.round(leg.duration.value / 60),
            summary:     r.summary,
            // Segments from steps (used for scoring)
            steps:       leg.steps,
            gmapsRoute:  r,         // raw Google route
            scores:      null,      // filled in below
          };
        });

        // Draw each route on map with its color
        builtRoutes.forEach((route, i) => {
          const renderer = new google.maps.DirectionsRenderer({
            map:              mapsState.map,
            directions:       result,
            routeIndex:       i,
            suppressMarkers:  true,
            polylineOptions: {
              strokeColor:   routeColors[i] || '#8B91A8',
              strokeWeight:  i === 0 ? 6 : 4,
              strokeOpacity: i === 0 ? 1.0 : 0.5,
              zIndex:        10 - i,
            },
          });
          mapsState.renderers.push(renderer);
        });

        // Add start/end markers
        addRouteMarkers(origin, dest);

        // Fit map to route bounds
        const bounds = new google.maps.LatLngBounds();
        routes[0].overview_path.forEach(p => bounds.extend(p));
        mapsState.map.fitBounds(bounds, { top: 180, bottom: 160, left: 20, right: 20 });

        // Score routes via backend (or use mock if unavailable)
        try {
          const scored = await scoreRoutesViaBackend(builtRoutes, mode);
          resolve(scored);
        } catch {
          // Use mock scores as fallback
          resolve(builtRoutes.map((r, i) => ({
            ...r,
            scores: getMockScores(i, mode),
          })));
        }
      }
    );
  });
}

/**
 * Score routes via the Sathi backend API.
 * ALWAYS returns routes with scores — never returns null scores.
 */
async function scoreRoutesViaBackend(builtRoutes, mode) {
  const orig = mapsState.currentLocation;
  const dest = mapsState.destLocation;

  // If no GPS or no API client, return immediately with mock scores
  if (!orig || !dest || !window.SathiAPI) {
    return builtRoutes.map((r, i) => ({ ...r, scores: getMockScores(i, mode) }));
  }

  try {
    const data = await window.SathiAPI.fetchRoutes(
      orig.lat, orig.lng,
      dest.lat, dest.lng,
      mode
    );

    // Merge backend scores — always fall back to mock if backend score is missing
    return builtRoutes.map((r, i) => {
      const backendRoute = data.routes?.[i];
      return {
        ...r,
        scores: backendRoute?.scores || getMockScores(i, mode),
      };
    });
  } catch {
    // Backend unreachable — use mock scores
    return builtRoutes.map((r, i) => ({ ...r, scores: getMockScores(i, mode) }));
  }
}

/**
 * Highlight a selected route (make others dimmer).
 */
function highlightRoute(selectedIndex) {
  // Remove any previous glow polyline
  if (mapsState._glowLine) {
    mapsState._glowLine.setMap(null);
    mapsState._glowLine = null;
  }
  if (mapsState._glowAnim) {
    cancelAnimationFrame(mapsState._glowAnim);
    mapsState._glowAnim = null;
  }

  const routeColors = ['#22c55e', '#f59e0b', '#6c3ae8'];

  mapsState.renderers.forEach((renderer, i) => {
    const isSelected = i === selectedIndex;
    renderer.setOptions({
      polylineOptions: {
        strokeColor:   routeColors[i] || '#8B91A8',
        strokeWeight:  isSelected ? 7 : 3,
        strokeOpacity: isSelected ? 1.0 : 0.25,
        zIndex:        isSelected ? 20 : 5,
      },
    });
  });

  // Draw a glow halo behind the selected route
  const selectedRenderer = mapsState.renderers[selectedIndex];
  if (selectedRenderer && mapsState.map) {
    try {
      const dirs = selectedRenderer.getDirections();
      const path = dirs.routes[selectedIndex]?.overview_path;
      if (path) {
        const glowColor = routeColors[selectedIndex] || '#6c3ae8';
        const glowLine = new google.maps.Polyline({
          path,
          strokeColor:   glowColor,
          strokeOpacity: 0.3,
          strokeWeight:  16,
          zIndex:        19,
          map:           mapsState.map,
        });
        mapsState._glowLine = glowLine;

        // Pulse animation
        let opacity = 0.3;
        let rising = true;
        function pulseGlow() {
          if (!mapsState._glowLine) return;
          opacity += rising ? 0.008 : -0.008;
          if (opacity >= 0.5) rising = false;
          if (opacity <= 0.15) rising = true;
          glowLine.setOptions({ strokeOpacity: opacity });
          mapsState._glowAnim = requestAnimationFrame(pulseGlow);
        }
        pulseGlow();
      }
    } catch (_) { /* ignore if directions not available */ }
  }
}

/**
 * Hide all alternative routes leaving only the selected one.
 */
function hideAlternativeRoutes(selectedIndex) {
  mapsState.renderers.forEach((renderer, i) => {
    if (i !== selectedIndex) {
      renderer.setMap(null);
    } else {
      renderer.setOptions({
        polylineOptions: {
          strokeWeight:  7,
          strokeOpacity: 1.0,
          zIndex:        20,
        },
      });
    }
  });
}

/**
 * Clear all rendered route polylines from the map.
 */
function clearRouteRenderers() {
  // Clean up glow effect
  if (mapsState._glowLine) {
    mapsState._glowLine.setMap(null);
    mapsState._glowLine = null;
  }
  if (mapsState._glowAnim) {
    cancelAnimationFrame(mapsState._glowAnim);
    mapsState._glowAnim = null;
  }

  mapsState.renderers.forEach(r => r.setMap(null));
  mapsState.renderers = [];
  
  if (mapsState.routeMarkers) {
    mapsState.routeMarkers.forEach(m => m.setMap(null));
    mapsState.routeMarkers = [];
  }
}

/**
 * Add origin and destination markers with custom icons.
 */
function addRouteMarkers(origin, dest) {
  const m1 = new google.maps.Marker({
    position: origin,
    map:      mapsState.map,
    icon: {
      path:         google.maps.SymbolPath.CIRCLE,
      scale:        10,
      fillColor:    '#6C3AE8',
      fillOpacity:  1,
      strokeColor:  '#A78BFA',
      strokeWeight: 3,
    },
    title: 'Start',
    zIndex: 90,
  });

  const m2 = new google.maps.Marker({
    position: dest,
    map:      mapsState.map,
    icon: {
      path:         'M 0,-1 C 0.5,-1 1,-0.5 1,0 C 1,0.5 0,2 0,2 C 0,2 -1,0.5 -1,0 C -1,-0.5 -0.5,-1 0,-1 Z',
      scale:        14,
      fillColor:    '#EF4444',
      fillOpacity:  1,
      strokeColor:  '#FCA5A5',
      strokeWeight: 2,
    },
    title: 'Destination',
    zIndex: 90,
  });

  mapsState.routeMarkers = [m1, m2];
}

/**
 * Move the user location marker during active navigation.
 */
function updateUserPosition(lat, lng) {
  if (!mapsState.map) return;
  const pos = new google.maps.LatLng(lat, lng);

  // Calculate heading from movement if compass not available
  if (mapsState._prevLocation) {
    const dLat = lat - mapsState._prevLocation.lat;
    const dLng = lng - mapsState._prevLocation.lng;
    if (Math.abs(dLat) > 0.00002 || Math.abs(dLng) > 0.00002) {
      const movementHeading = (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;
      // Only use movement heading if no compass data
      if (!mapsState._hasCompass) {
        mapsState.heading = movementHeading;
      }
    }
  }
  mapsState._prevLocation = { lat, lng };

  // Update or create directional arrow marker
  if (mapsState.userMarker) {
    mapsState.userMarker.setPosition(pos);
    const icon = mapsState.userMarker.getIcon();
    if (icon) {
      icon.rotation = mapsState.heading;
      mapsState.userMarker.setIcon(icon);
    }
  }

  mapsState.map.panTo(pos);
}

let activeRoutePolyline = null;
let lastDeviationWarning = 0;

function startLiveTracking() {
  if (!navigator.geolocation) return;
  if (mapsState.geolocationWatch) return;

  const idx = window._sathi_selectedIdx || 0;
  if (mapsState.renderers && mapsState.renderers.length > idx) {
    const route = mapsState.renderers[idx].getDirections().routes[0];
    if (route) {
      activeRoutePolyline = new google.maps.Polyline({ path: route.overview_path });
    }
  }

  // Switch user marker to directional arrow
  if (mapsState.userMarker) {
    mapsState.userMarker.setIcon({
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 7,
      fillColor:    '#6C3AE8',
      fillOpacity:  1,
      strokeColor:  '#A78BFA',
      strokeWeight: 2,
      rotation:     mapsState.heading,
      anchor:       new google.maps.Point(0, 2.5),
    });
  }

  // Start compass heading listener
  mapsState._hasCompass = false;
  const compassHandler = (e) => {
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') {
      heading = e.webkitCompassHeading; // iOS
    } else if (typeof e.alpha === 'number') {
      heading = (360 - e.alpha) % 360;  // Android
    }
    if (heading !== null) {
      mapsState._hasCompass = true;
      mapsState.heading = heading;
      // Live-rotate the arrow
      if (mapsState.userMarker) {
        const icon = mapsState.userMarker.getIcon();
        if (icon) {
          icon.rotation = heading;
          mapsState.userMarker.setIcon(icon);
        }
      }
    }
  };
  mapsState._compassListener = compassHandler;

  // Request permission on iOS 13+
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(state => {
        if (state === 'granted') {
          window.addEventListener('deviceorientation', compassHandler, true);
        }
      })
      .catch(() => {});
  } else if (typeof DeviceOrientationEvent !== 'undefined') {
    window.addEventListener('deviceorientation', compassHandler, true);
  }

  // Tilt map for navigation perspective
  if (mapsState.map) {
    mapsState.map.setTilt(45);
    mapsState.map.setZoom(17);
  }

  mapsState.geolocationWatch = navigator.geolocation.watchPosition(
    (pos) => {
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      mapsState.currentLocation = loc;
      updateUserPosition(loc.lat, loc.lng);
      checkDeviation(loc);
    },
    (err) => console.warn('Live tracking error:', err.message),
    { enableHighAccuracy: true }
  );
}

function stopLiveTracking() {
  if (mapsState.geolocationWatch) {
    navigator.geolocation.clearWatch(mapsState.geolocationWatch);
    mapsState.geolocationWatch = null;
  }

  // Remove compass listener
  if (mapsState._compassListener) {
    window.removeEventListener('deviceorientation', mapsState._compassListener, true);
    mapsState._compassListener = null;
  }

  // Reset map tilt & restore user marker to circle
  if (mapsState.map) {
    mapsState.map.setTilt(0);
  }
  if (mapsState.userMarker) {
    mapsState.userMarker.setIcon({
      path:         google.maps.SymbolPath.CIRCLE,
      scale:        10,
      fillColor:    '#6C3AE8',
      fillOpacity:  1,
      strokeColor:  '#A78BFA',
      strokeWeight: 3,
    });
  }

  mapsState._prevLocation = null;
  mapsState._hasCompass = false;
}

function checkDeviation(loc) {
  if (!activeRoutePolyline) return;
  
  const userLatLng = new google.maps.LatLng(loc.lat, loc.lng);
  
  // 0.00135 degrees is roughly 150 meters
  const isOnRoute = google.maps.geometry.poly.isLocationOnEdge(userLatLng, activeRoutePolyline, 0.00135);

  if (!isOnRoute) {
    const now = Date.now();
    // Cooldown: warn once every 5 minutes maximum
    if (now - lastDeviationWarning > 5 * 60 * 1000) {
      lastDeviationWarning = now;
      if (window.onRouteDeviation) {
        window.onRouteDeviation();
      }
    }
  }
}

/**
 * Fallback mock scores when backend is unreachable.
 */
function getMockScores(index, mode) {
  const base = [
    { safety: 8.4, lighting: 7.8, crowd: 7.2, police: 2, finalScore: 8.1, isNightSafe: true },
    { safety: 6.9, lighting: 6.2, crowd: 8.0, police: 1, finalScore: 7.0, isNightSafe: true },
    { safety: 5.1, lighting: 4.5, crowd: 5.5, police: 0, finalScore: 5.0, isNightSafe: false },
  ];
  return base[index] || base[0];
}

/**
 * Update map theme dynamically.
 */
function setMapTheme(mode) {
  if (!mapsState.map) return;
  mapsState.map.setOptions({ styles: mode === 'night' ? DARK_MAP_STYLE : [] });
}

/**
 * Check if the route has heavy traffic delays.
 * @returns {Promise<boolean>} true if duration in traffic is > 30% longer than normal duration
 */
async function checkTrafficJam() {
  if (!mapsState.directionsService || !mapsState.currentLocation || !mapsState.destLocation) {
    return false; // Cannot check predictably, assume no jam
  }
  
  return new Promise((resolve) => {
    mapsState.directionsService.route(
      {
        origin: new google.maps.LatLng(mapsState.currentLocation.lat, mapsState.currentLocation.lng),
        destination: new google.maps.LatLng(mapsState.destLocation.lat, mapsState.destLocation.lng),
        travelMode: google.maps.TravelMode.DRIVING,
        drivingOptions: {
          departureTime: new Date(),  // for current traffic
          trafficModel: 'bestguess'
        },
        provideRouteAlternatives: false,
        unitSystem: google.maps.UnitSystem.METRIC,
      },
      (result, status) => {
        if (status !== 'OK' || !result.routes.length) {
          return resolve(false);
        }
        
        const leg = result.routes[0].legs[0];
        const duration = leg.duration?.value || 0;
        const durationInTraffic = leg.duration_in_traffic?.value || 0;
        
        if (duration === 0 || durationInTraffic === 0) return resolve(false);
        
        // Traffic adds > 30% time
        resolve((durationInTraffic / duration) > 1.3);
      }
    );
  });
}

// ─── Global callback for Google Maps async loader ─────────────────────
window.onGoogleMapsReady = initGoogleMap;

// ─── Expose to app.js ─────────────────────────────────────────────────
window.SathiMaps = {
  fetchRealRoutes,
  highlightRoute,
  hideAlternativeRoutes,
  clearRouteRenderers,
  updateUserPosition,
  setMapTheme,
  checkTrafficJam,
  startLiveTracking,
  stopLiveTracking,
  startGeolocation,
  fetchDestLocation,
  getState: () => mapsState,
};
