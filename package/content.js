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
      const url = `https://biketerra.com/ride/__data.json?route=${routeId}`;
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

  // Extract route elevation/distance data from the response
  function extractRouteData(data) {
    try {
      const dataArray = data.nodes?.[1]?.data;
      if (!dataArray) return null;

      // Follow route reference chain
      const routeIdx = dataArray[0]?.route;
      if (!routeIdx) return null;

      const route = dataArray[routeIdx];

      // Get distance in cm, convert to meters
      const totalDistance = dataArray[route.distance] / 100;

      // Parse simple_route for elevation range
      const routePoints = JSON.parse(dataArray[route.simple_route]);
      const minElev = Math.min(...routePoints.map(p => p[2]));
      const maxElev = Math.max(...routePoints.map(p => p[2]));

      return { totalDistance, minElev, maxElev };
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

    // Calculate minimum X span so that one Y quantum (0.001) represents ≤ 1% gradient
    // This addresses quantization noise from the limited precision of Y coordinates
    const yQuantum = 0.001;
    const maxGradientPerQuantum = 1; // 1% max gradient contribution per Y quantum
    const minDX = (yQuantum * elevRange * 100) / (ySpan * maxGradientPerQuantum * totalDistance);

    for (let i = 0; i < elevationPoints.length - 1; i++) {
      const p1 = elevationPoints[i];
      const p2 = elevationPoints[i + 1];

      // Find points at least minDX apart (centered on this segment) for gradient calculation
      const centerX = (p1.x + p2.x) / 2;
      const targetStartX = centerX - minDX / 2;
      const targetEndX = centerX + minDX / 2;

      // Find starting point
      let startIdx = i;
      while (startIdx > 0 && elevationPoints[startIdx].x > targetStartX) {
        startIdx--;
      }

      // Find ending point
      let endIdx = i + 1;
      while (endIdx < elevationPoints.length - 1 && elevationPoints[endIdx].x < targetEndX) {
        endIdx++;
      }

      const pStart = elevationPoints[startIdx];
      const pEnd = elevationPoints[endIdx];

      // Calculate gradient from the wider span
      // SVG Y is inverted: 0 = top (high elev), 1 = bottom (low elev)
      // So negative dY (going up visually) = climbing = positive gradient
      const dY = pStart.y - pEnd.y; // Positive when climbing (Y decreasing)
      const dX = pEnd.x - pStart.x;

      if (dX <= 0) continue; // Skip invalid segments

      // Convert normalized slope to actual gradient percentage
      // dY/ySpan = proportion of elevation range
      // (dY/ySpan) * elevRange = elevation change in meters
      // dX * totalDistance = distance change in meters
      const gradient = ((dY * elevRange) / (ySpan * dX * totalDistance)) * 100;

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

  // Get Y value at a given X position using linear interpolation
  function getYAtX(points, targetX) {
    if (points.length === 0) return null;
    if (targetX <= points[0].x) return points[0].y;
    if (targetX >= points[points.length - 1].x) return points[points.length - 1].y;

    for (let i = 1; i < points.length; i++) {
      if (points[i].x >= targetX) {
        const prev = points[i - 1];
        const curr = points[i];
        const t = (targetX - prev.x) / (curr.x - prev.x);
        return prev.y + (curr.y - prev.y) * t;
      }
    }

    return null;
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
