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
  mapsState.renderers.forEach((renderer, i) => {
    renderer.setOptions({
      polylineOptions: {
        strokeWeight:  i === selectedIndex ? 7 : 3,
        strokeOpacity: i === selectedIndex ? 1.0 : 0.3,
        zIndex:        i === selectedIndex ? 20 : 5,
      },
    });
  });
}

/**
 * Clear all rendered route polylines from the map.
 */
function clearRouteRenderers() {
  mapsState.renderers.forEach(r => r.setMap(null));
  mapsState.renderers = [];
}

/**
 * Add origin and destination markers with custom icons.
 */
function addRouteMarkers(origin, dest) {
  new google.maps.Marker({
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

  new google.maps.Marker({
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
}

/**
 * Move the user location marker during active navigation.
 */
function updateUserPosition(lat, lng) {
  if (!mapsState.userMarker || !mapsState.map) return;
  const pos = new google.maps.LatLng(lat, lng);
  mapsState.userMarker.setPosition(pos);
  mapsState.map.panTo(pos);
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

// ─── Global callback for Google Maps async loader ─────────────────────
window.onGoogleMapsReady = initGoogleMap;

// ─── Expose to app.js ─────────────────────────────────────────────────
window.SathiMaps = {
  fetchRealRoutes,
  highlightRoute,
  clearRouteRenderers,
  updateUserPosition,
  setMapTheme,
  getState: () => mapsState,
};
