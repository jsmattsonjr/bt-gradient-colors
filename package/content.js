// Biketerra Gradient Colors - Content Script
// Fetches route data and recolors elevation graph

(function () {
  'use strict';

  console.log('[Gradient Colors] Content script loaded');

  // Find route ID from DOM (appears as "(#nnnn)" in route menu)
  function findRouteId() {
    const routeIdElem = document.querySelector('.route-id');
    if (routeIdElem) {
      const match = routeIdElem.textContent.match(/#(\d+)/);
      if (match) {
        return match[1];
      }
    }
    return null;
  }

  // Fetch route data from Biketerra API
  async function fetchRouteData(routeId) {
    try {
      const url = `https://biketerra.com/routes/${routeId}/__data.json`;
      console.log('[Gradient Colors] Fetching route data from:', url);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return extractRouteData(data);
    } catch (e) {
      console.error('[Gradient Colors] Error fetching route data:', e);
      return null;
    }
  }

  // Dereference a pointer index in the Biketerra data array
  function deref(dataArray, index) {
    return dataArray[index];
  }

  // Extract route elevation/distance data from the response
  function extractRouteData(data) {
    try {
      const dataArray = data.nodes?.[2]?.data;
      if (!dataArray) return null;

      // Get field schema and route data
      const refs = dataArray[0];
      const schema = dataArray[refs.route];
      if (!schema) return null;

      // Get distance in cm, convert to meters
      const totalDistance = dataArray[schema.distance] / 100;

      // Extract latLngData for full-precision elevation/distance data
      const latLngDataIdx = refs.latLngData;
      if (!latLngDataIdx) {
        console.warn('[Gradient Colors] No latLngData found');
        return null;
      }

      const latLngData = deref(dataArray, latLngDataIdx);
      const routePoints = [];

      for (const pointIdx of latLngData) {
        const pointRefs = deref(dataArray, pointIdx);
        // Point structure: [lat_idx, lng_idx, ele_idx, distance_idx, smoothed_ele_idx]
        const elevation = deref(dataArray, pointRefs[2]); // Raw elevation
        const distance = deref(dataArray, pointRefs[3]); // Distance in meters
        routePoints.push({ distance, elevation });
      }

      // Compute min/max elevation from route points
      const elevations = routePoints.map(p => p.elevation);
      const minElev = Math.min(...elevations);
      const maxElev = Math.max(...elevations);

      console.log('[Gradient Colors] Extracted', routePoints.length, 'route points');

      return { totalDistance, minElev, maxElev, routePoints };
    } catch (e) {
      console.error('[Gradient Colors] Error extracting route data:', e);
      return null;
    }
  }

  // Initialize: find route ID and fetch data
  let initializeInProgress = false;

  async function initialize() {
    const routeId = findRouteId();
    if (!routeId) {
      return false;
    }

    // Check if we already have data for this route
    if (window._biketerraRouteId === routeId && window._biketerraRouteData) {
      processElevationSVG();
      return true;
    }

    // Prevent concurrent fetches
    if (initializeInProgress) {
      return false;
    }
    initializeInProgress = true;

    console.log('[Gradient Colors] Found route ID:', routeId);

    const routeData = await fetchRouteData(routeId);
    initializeInProgress = false;

    if (routeData) {
      console.log('[Gradient Colors] Got route data:', routeData);
      window._biketerraRouteId = routeId;
      window._biketerraRouteData = routeData;
      processElevationSVG();
      return true;
    }

    return false;
  }

  // Default settings
  const DEFAULT_SETTINGS = {
    colorStops: ['#713071', '#0c4ae0', '#28eaed', '#24ca26', '#f1f060', '#d90916', '#430102'],
    distance: 7,
  };

  // Current settings (loaded from storage)
  let settings = { ...DEFAULT_SETTINGS };

  // Load settings from storage
  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, function (stored) {
        settings = stored;
        console.log('[Gradient Colors] Loaded settings:', settings);
        resolve(settings);
      });
    });
  }

  // Listen for settings changes
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync') {
      if (changes.colorStops) {
        settings.colorStops = changes.colorStops.newValue;
      }
      if (changes.distance) {
        settings.distance = changes.distance.newValue;
      }
      console.log('[Gradient Colors] Settings updated:', settings);
      // Reprocess SVG with new colors
      const svg = document.querySelector('svg.pathSVG');
      if (svg) {
        svg.dataset.gradientColored = 'false';
        svg.querySelectorAll('polygon').forEach(p => p.remove());
        processElevationSVG();
      }
      // Update grade circle
      updateGradientCircleColor();
    }
  });

  function gradientToColor(gradient) {
    const normalized = Math.max(-3, Math.min(3, gradient / settings.distance));
    const band = Math.max(-3, Math.min(2, Math.floor(normalized)));
    const t = normalized - band;
    return lerpColor(settings.colorStops[band + 3], settings.colorStops[band + 4], t);
  }

  // Interpolate elevation at a given distance using route points
  function interpolateElevation(routePoints, distance) {
    if (routePoints.length === 0) return 0;
    if (distance <= routePoints[0].distance) return routePoints[0].elevation;
    if (distance >= routePoints[routePoints.length - 1].distance) {
      return routePoints[routePoints.length - 1].elevation;
    }

    // Binary search for the right segment
    let lo = 0,
      hi = routePoints.length - 1;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (routePoints[mid].distance <= distance) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    const p1 = routePoints[lo];
    const p2 = routePoints[hi];
    const t = (distance - p1.distance) / (p2.distance - p1.distance);
    return p1.elevation + t * (p2.elevation - p1.elevation);
  }

  // Compute gradient (%) at a given distance using route points
  // Uses a small window around the point to get a smoothed gradient
  function computeGradientAtDistance(routePoints, distance, totalDistance, windowSize = 50) {
    // Use a window of +/- windowSize meters (or available range)
    const d1 = Math.max(0, distance - windowSize);
    const d2 = Math.min(totalDistance, distance + windowSize);

    const e1 = interpolateElevation(routePoints, d1);
    const e2 = interpolateElevation(routePoints, d2);

    const deltaD = d2 - d1;
    if (deltaD <= 0) return 0;

    return ((e2 - e1) / deltaD) * 100;
  }

  // Get SVG Y value at a given X position using linear interpolation
  function getSvgYAtX(svgPoints, targetX) {
    if (svgPoints.length === 0) return null;
    if (targetX <= svgPoints[0].x) return svgPoints[0].y;
    if (targetX >= svgPoints[svgPoints.length - 1].x) {
      return svgPoints[svgPoints.length - 1].y;
    }

    for (let i = 1; i < svgPoints.length; i++) {
      if (svgPoints[i].x >= targetX) {
        const p1 = svgPoints[i - 1];
        const p2 = svgPoints[i];
        const t = (targetX - p1.x) / (p2.x - p1.x);
        return p1.y + t * (p2.y - p1.y);
      }
    }
    return svgPoints[svgPoints.length - 1].y;
  }

  // Compute sum of squared errors between two arrays
  function sumSquaredError(arr1, arr2) {
    let sum = 0;
    for (let i = 0; i < arr1.length; i++) {
      const diff = arr1[i] - arr2[i];
      sum += diff * diff;
    }
    return sum;
  }

  // Normalize array to 0-1 range for comparison
  function normalizeArray(arr) {
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const range = max - min || 1;
    return arr.map(v => (v - min) / range);
  }

  // Find positions where forward and reverse elevations differ most
  // Returns array of {x, diff} sorted by difference (largest first)
  function findAsymmetricPositions(routePoints, totalDistance, numCandidates = 100) {
    const candidates = [];
    for (let i = 1; i < numCandidates; i++) {
      const x = i / numCandidates;
      const fwdElev = interpolateElevation(routePoints, x * totalDistance);
      const revElev = interpolateElevation(routePoints, (1 - x) * totalDistance);
      candidates.push({ x, diff: Math.abs(fwdElev - revElev) });
    }
    return candidates.sort((a, b) => b.diff - a.diff);
  }

  // Detect whether SVG matches forward or reversed route
  // Samples at positions where forward/reverse elevations differ most
  function detectRouteDirection(svgPoints, routePoints, totalDistance) {
    // Find positions where forward and reverse routes differ most
    const asymmetricPositions = findAsymmetricPositions(routePoints, totalDistance);

    // If route is nearly symmetrical (max difference < 1m), direction doesn't matter
    if (asymmetricPositions[0].diff < 1) {
      console.log(
        '[Gradient Colors] Direction detection: forward (route is symmetrical, max diff:',
        asymmetricPositions[0].diff.toFixed(2) + 'm)'
      );
      return 'forward';
    }

    // Take top 5 most asymmetric positions as sample points
    const sampleXs = asymmetricPositions.slice(0, 5).map(p => p.x);

    // Get SVG Y values at sample points (negate because lower Y = higher elevation)
    const svgElevs = sampleXs.map(x => -getSvgYAtX(svgPoints, x));

    // Get forward route elevations at same normalized positions
    const fwdElevs = sampleXs.map(x => interpolateElevation(routePoints, x * totalDistance));

    // Get reverse route elevations (x=0 maps to end of route)
    const revElevs = sampleXs.map(x => interpolateElevation(routePoints, (1 - x) * totalDistance));

    // Normalize all arrays for comparison (removes scale differences)
    const svgNorm = normalizeArray(svgElevs);
    const fwdNorm = normalizeArray(fwdElevs);
    const revNorm = normalizeArray(revElevs);

    // Compute errors
    const fwdError = sumSquaredError(svgNorm, fwdNorm);
    const revError = sumSquaredError(svgNorm, revNorm);

    const direction = fwdError <= revError ? 'forward' : 'reverse';
    console.log(
      '[Gradient Colors] Direction detection:',
      direction,
      '(fwdErr:',
      fwdError.toFixed(4),
      'revErr:',
      revError.toFixed(4),
      'maxAsymmetry:',
      asymmetricPositions[0].diff.toFixed(1) + 'm)'
    );
    return direction;
  }

  // Linear interpolation between two hex colors
  function lerpColor(color1, color2, t) {
    const r1 = parseInt(color1.slice(1, 3), 16);
    const g1 = parseInt(color1.slice(3, 5), 16);
    const b1 = parseInt(color1.slice(5, 7), 16);

    const r2 = parseInt(color2.slice(1, 3), 16);
    const g2 = parseInt(color2.slice(3, 5), 16);
    const b2 = parseInt(color2.slice(5, 7), 16);

    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);

    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  // Process the elevation SVG and recolor it
  function processElevationSVG() {
    const routeData = window._biketerraRouteData;
    if (!routeData) {
      console.log('[Gradient Colors] No route data available yet');
      return;
    }

    const svg = document.querySelector('svg.pathSVG');
    if (!svg) {
      console.log('[Gradient Colors] SVG not found yet');
      return;
    }

    // Check if already processed
    if (svg.dataset.gradientColored === 'true') {
      return;
    }

    console.log('[Gradient Colors] Processing SVG with route data...');

    // Find ALL stroke polylines - we only want the LAST one (the active one)
    const strokePolylines = svg.querySelectorAll('polyline[stroke="#fffa"]');
    if (strokePolylines.length === 0) {
      console.log('[Gradient Colors] No stroke polylines found');
      return;
    }

    // Only process the last (most recent/active) stroke polyline
    const strokePolyline = strokePolylines[strokePolylines.length - 1];
    console.log(
      '[Gradient Colors] Processing active polyline (last of',
      strokePolylines.length,
      ')'
    );

    const pointsStr = strokePolyline.getAttribute('points');
    const points = parsePolylinePoints(pointsStr);

    if (points.length < 2) {
      console.log('[Gradient Colors] Not enough points in polyline');
      return;
    }

    // Get scaling factors from route data
    const { totalDistance, minElev, maxElev } = routeData;
    const elevRange = maxElev - minElev || 1;

    // Calculate the actual Y span of the polyline (it doesn't span 0-1)
    const yMin = Math.min(...points.map(p => p.y));
    const yMax = Math.max(...points.map(p => p.y));
    const ySpan = yMax - yMin || 1;

    console.log('[Gradient Colors] Y span:', ySpan, 'elevRange:', elevRange);

    // Remove any existing polygons we created
    svg.querySelectorAll('polygon').forEach(p => p.remove());

    // Hide ALL filled polylines (including Biketerra's colored gradients)
    // Our gradient polygons will replace them
    svg.querySelectorAll('polyline[fill]:not([fill="none"])').forEach(pl => {
      pl.style.display = 'none';
    });

    // Hide OLD stroke polylines (not the active one)
    strokePolylines.forEach((pl, idx) => {
      if (idx < strokePolylines.length - 1) {
        pl.style.display = 'none';
      }
    });

    // Create gradient-colored segments using actual polyline points
    // Filter out y=1 points which are segment boundaries, not elevation data
    const elevationPoints = points.filter(p => p.y < 1);

    // Check if we have full route data for accurate gradient calculation
    const { routePoints } = routeData;
    const useRouteData = routePoints && routePoints.length > 1;

    // Detect route direction (forward or reverse)
    let isReversed = false;
    if (useRouteData) {
      const direction = detectRouteDirection(elevationPoints, routePoints, totalDistance);
      isReversed = direction === 'reverse';
      console.log('[Gradient Colors] Using route data for accurate gradients (' + direction + ')');
    } else {
      console.log('[Gradient Colors] Falling back to SVG-based gradient estimation');
    }

    for (let i = 0; i < elevationPoints.length - 1; i++) {
      const p1 = elevationPoints[i];
      const p2 = elevationPoints[i + 1];

      let gradient;

      if (useRouteData) {
        // Use route data for accurate gradient calculation
        // SVG x is normalized (0-1), convert to distance
        const centerX = (p1.x + p2.x) / 2;
        // If reversed, x=0 is end of route, x=1 is start
        const distance = isReversed ? (1 - centerX) * totalDistance : centerX * totalDistance;
        gradient = computeGradientAtDistance(routePoints, distance, totalDistance);
        // Negate gradient when reversed (going backwards on the route)
        if (isReversed) gradient = -gradient;
      } else {
        // Fallback: estimate gradient from SVG coordinates (has quantization noise)
        const yQuantum = 0.001;
        const maxGradientPerQuantum = 1;
        const minDX =
          (yQuantum * elevRange * 100) / (ySpan * maxGradientPerQuantum * totalDistance);

        const centerX = (p1.x + p2.x) / 2;
        const targetStartX = centerX - minDX / 2;
        const targetEndX = centerX + minDX / 2;

        let startIdx = i;
        while (startIdx > 0 && elevationPoints[startIdx].x > targetStartX) {
          startIdx--;
        }

        let endIdx = i + 1;
        while (endIdx < elevationPoints.length - 1 && elevationPoints[endIdx].x < targetEndX) {
          endIdx++;
        }

        const pStart = elevationPoints[startIdx];
        const pEnd = elevationPoints[endIdx];
        const dY = pStart.y - pEnd.y;
        const dX = pEnd.x - pStart.x;

        if (dX <= 0) continue;
        gradient = ((dY * elevRange) / (ySpan * dX * totalDistance)) * 100;
      }

      const color = gradientToColor(gradient);

      // Create a filled polygon for this segment
      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      const polygonPoints = `${p1.x},1 ${p1.x},${p1.y} ${p2.x},${p2.y} ${p2.x},1`;
      polygon.setAttribute('points', polygonPoints);
      polygon.setAttribute('fill', color);
      // Use matching stroke to cover hairline gaps between adjacent polygons
      polygon.setAttribute('stroke', color);
      polygon.setAttribute('stroke-width', '1.5');
      polygon.setAttribute('vector-effect', 'non-scaling-stroke');

      // Insert before the stroke line
      svg.insertBefore(polygon, strokePolyline);
    }

    // Mark as processed
    svg.dataset.gradientColored = 'true';
    console.log('[Gradient Colors] SVG processing complete');
  }

  // Parse polyline points string into array of {x, y}
  function parsePolylinePoints(pointsStr) {
    const points = [];
    const pairs = pointsStr.trim().split(/\s+/);

    for (const pair of pairs) {
      const [x, y] = pair.split(',').map(Number);
      if (!isNaN(x) && !isNaN(y)) {
        points.push({ x, y });
      }
    }

    return points;
  }

  // Watch for DOM changes (new SVGs, route ID appearing, grade circle)
  const domObserver = new MutationObserver(function (mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check for SVG
            if (node.matches && node.matches('svg.pathSVG')) {
              initialize();
              setupPolylineObserver();
            } else if (node.querySelector) {
              if (node.querySelector('svg.pathSVG')) {
                initialize();
                setupPolylineObserver();
              }
              // Check for route ID appearing
              if (node.querySelector('.route-id') || (node.matches && node.matches('.route-id'))) {
                initialize();
              }
              // Check for grade circle appearing
              if (node.querySelector('.panel-grade, .stat-grade')) {
                setupGradientCircleObserver();
              }
            }
          }
        }
      }
    }
  });

  // Start observing for DOM changes
  domObserver.observe(document.body, { childList: true, subtree: true });

  // Watch for SVG content changes (handles direction reversal on out-and-back routes)
  let svgContentObserver = null;
  let observedSvg = null;
  let debounceTimer = null;

  // Gradient circle observer state
  let gradientCircleObserver = null;
  let isUpdatingCircle = false;
  let observedCircle = null;

  function setupPolylineObserver() {
    const svg = document.querySelector('svg.pathSVG');
    if (!svg) return;

    // Don't set up again if we're already observing this SVG
    if (observedSvg === svg) return;

    // Disconnect old observer if switching to new SVG
    if (svgContentObserver) {
      svgContentObserver.disconnect();
    }

    console.log('[Gradient Colors] Setting up SVG content observer for direction changes');
    observedSvg = svg;

    svgContentObserver = new MutationObserver(function (mutations) {
      // Check if any polylines were added (ignore our polygon additions)
      const hasPolylineChange = mutations.some(m =>
        Array.from(m.addedNodes).some(n => n.nodeName === 'polyline')
      );

      if (!hasPolylineChange) return;

      // Debounce to avoid multiple rapid reprocesses
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        console.log('[Gradient Colors] SVG polylines changed, reprocessing...');

        // Clear processed state and remove old polygons
        svg.dataset.gradientColored = 'false';
        svg.querySelectorAll('polygon').forEach(p => p.remove());

        // Reprocess
        processElevationSVG();
      }, 50);
    });

    // Watch for child elements being added/removed within the SVG
    svgContentObserver.observe(svg, {
      childList: true,
      subtree: true,
    });
  }

  // Initialize on load (after loading settings)
  loadSettings().then(function () {
    initialize();
    setupPolylineObserver();
    setupGradientCircleObserver();
  });

  // Keyboard shortcut: 'g' toggles global/local elevation graph
  document.addEventListener('keydown', function (e) {
    // Ignore if typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'g' || e.key === 'G') {
      const elevPanel =
        document.querySelector('.elev-graph') || document.querySelector('.panel-elevation-profile');
      if (elevPanel) {
        elevPanel.click();
      }
    }
  });

  function setupGradientCircleObserver() {
    // Target the GRADE circle specifically, not the DRAFT circle
    const circle = document.querySelector(
      '.panel-grade .stat-circle-fill, .stat-grade .stat-circle-fill'
    );
    if (!circle) return;

    // Don't set up again if we're already observing this circle
    if (observedCircle === circle) return;

    // Disconnect old observer if switching to new circle
    if (gradientCircleObserver) {
      gradientCircleObserver.disconnect();
    }

    console.log('[Gradient Colors] Setting up gradient circle observer on GRADE indicator');
    observedCircle = circle;

    // Create observer to watch for style and content changes
    gradientCircleObserver = new MutationObserver(function (_mutations) {
      // Skip if we're the ones making the change
      if (isUpdatingCircle) return;

      updateGradientCircleColor(circle);
    });

    // Watch style attribute changes on the circle fill
    gradientCircleObserver.observe(circle, {
      attributes: true,
      attributeFilter: ['style'],
    });

    // Also watch for value text changes
    const valueElem = circle.parentElement?.querySelector('.stat-circle-value');
    if (valueElem) {
      gradientCircleObserver.observe(valueElem, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }

    // Initial update (and a delayed one to catch race conditions)
    updateGradientCircleColor(circle);
    setTimeout(function () {
      updateGradientCircleColor(circle);
    }, 500);
  }

  function updateGradientCircleColor(circle) {
    if (!circle) {
      circle = document.querySelector(
        '.panel-grade .stat-circle-fill, .stat-grade .stat-circle-fill'
      );
    }
    if (!circle) return;

    // Find the grade value from the sibling element
    const parent = circle.parentElement;
    if (!parent) return;

    const valueElem = parent.querySelector('.stat-circle-value');
    if (!valueElem) return;

    const gradient = parseFloat(valueElem.textContent);
    if (!isNaN(gradient)) {
      const color = gradientToColor(gradient);

      // Set guard before making changes
      isUpdatingCircle = true;

      // Use setProperty with !important to override CSS variables
      circle.style.setProperty('background-color', color, 'important');

      // Add dark outline to the text for readability on bright backgrounds
      valueElem.style.setProperty(
        'text-shadow',
        '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
        'important'
      );

      // Clear guard after a brief delay (allow mutation to fire and be ignored)
      setTimeout(function () {
        isUpdatingCircle = false;
      }, 10);
    }
  }
})();
