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
      // The data structure is SvelteKit format
      if (!data.nodes || !Array.isArray(data.nodes)) {
        console.log('[Gradient Colors] No nodes array found');
        return null;
      }

      // Look for the route data node
      for (const node of data.nodes) {
        if (node.type === 'data' && node.data) {
          const dataArray = node.data;

          // Find the simple_route field (JSON string like [[lat, lng, elev, dist], ...])
          for (const item of dataArray) {
            if (typeof item === 'string' && item.startsWith('[[') && item.includes('.')) {
              try {
                const routePoints = JSON.parse(item);
                if (Array.isArray(routePoints) && routePoints.length > 0 &&
                  Array.isArray(routePoints[0]) && routePoints[0].length >= 4) {
                  // Only extract elevation and distance (indices 2 and 3)
                  return routePoints.map(point => ({
                    elevation: point[2],
                    distance: point[3]
                  }));
                }
              } catch (e) {
                // Not valid JSON, continue
              }
            }
          }
        }
      }

      console.log('[Gradient Colors] Could not find simple_route in data');
      return null;
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

    if (routeData && routeData.length > 0) {
      console.log('[Gradient Colors] Got route data with', routeData.length, 'points');
      window._biketerraRouteId = routeId;
      window._biketerraRouteData = routeData;
      processElevationSVG();
      return true;
    }

    return false;
  }

  // Gradient color scale
  function gradientToColor(gradient) {
    // Clamp gradient to range
    const g = Math.max(-27.5, Math.min(27.5, gradient));

    // Color stops
    const green = '#24ca26';
    const yellow = '#f1f060';
    const red = '#d90916';
    const maroon = '#430102';
    const cyan = '#28eaed';
    const blue = '#0c4ae0';
    const purple = '#307171';

    if (g >= 0) {
      // Positive gradients (climbing)
      if (g <= 7.5) {
        return lerpColor(green, yellow, g / 7.5);
      } else if (g <= 15) {
        return lerpColor(yellow, red, (g - 7.5) / 7.5);
      } else {
        return lerpColor(red, maroon, (g - 15) / 12.5);
      }
    } else {
      // Negative gradients (descending)
      const absG = -g;
      if (absG <= 7.5) {
        return lerpColor(green, cyan, absG / 7.5);
      } else if (absG <= 15) {
        return lerpColor(cyan, blue, (absG - 7.5) / 7.5);
      } else {
        return lerpColor(blue, purple, (absG - 15) / 12.5);
      }
    }
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
    if (!routeData || routeData.length < 2) {
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
    console.log('[Gradient Colors] Processing active polyline (last of', strokePolylines.length, ')');

    const pointsStr = strokePolyline.getAttribute('points');
    const points = parsePolylinePoints(pointsStr);

    if (points.length < 2) {
      console.log('[Gradient Colors] Not enough points in polyline');
      return;
    }

    // Get scaling factors from route data
    const totalDistance = routeData[routeData.length - 1].distance; // meters
    const minElev = Math.min(...routeData.map(p => p.elevation));
    const maxElev = Math.max(...routeData.map(p => p.elevation));
    const elevRange = maxElev - minElev || 1; // meters

    // Remove any existing polygons we created
    svg.querySelectorAll('polygon').forEach(p => p.remove());

    // Hide filled polylines (the dark fill that would cover our gradient)
    // Keep only the stroke polyline visible
    svg.querySelectorAll('polyline[fill]:not([fill="none"])').forEach(pl => {
      // Don't hide the position indicator (it has var(--bt-a) fill and is small)
      if (!pl.getAttribute('fill').includes('var(')) {
        pl.style.display = 'none';
      }
    });

    // Hide OLD stroke polylines (not the active one)
    strokePolylines.forEach((pl, idx) => {
      if (idx < strokePolylines.length - 1) {
        pl.style.display = 'none';
      }
    });

    // Create gradient-colored segments
    const segmentWidth = 0.005;

    for (let x = 0; x < 1; x += segmentWidth) {
      const xEnd = Math.min(x + segmentWidth, 1);

      // Get elevation values at start and end of segment from polyline
      const yStart = getYAtX(points, x);
      const yEnd = getYAtX(points, xEnd);

      if (yStart === null || yEnd === null) continue;

      // Calculate gradient directly from polyline slope
      // SVG Y is inverted: 0 = top (high elev), 1 = bottom (low elev)
      // So negative dY (going up visually) = climbing = positive gradient
      const dY = yStart - yEnd; // Positive when climbing (Y decreasing)
      const dX = xEnd - x;

      // Convert normalized slope to actual gradient percentage
      // dY * elevRange = elevation change in meters
      // dX * totalDistance = distance change in meters
      const gradient = (dY * elevRange) / (dX * totalDistance) * 100;

      const color = gradientToColor(gradient);

      // Create a filled polygon for this segment
      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      const polygonPoints = `${x},1 ${x},${yStart} ${xEnd},${yEnd} ${xEnd},1`;
      polygon.setAttribute('points', polygonPoints);
      polygon.setAttribute('fill', color);
      polygon.setAttribute('stroke', 'none');

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
      subtree: true
    });
  }

  // Initialize on load
  initialize();
  setupPolylineObserver();
  setupGradientCircleObserver();

  // Keyboard shortcut: 'g' toggles global/local elevation graph
  document.addEventListener('keydown', function (e) {
    // Ignore if typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'g' || e.key === 'G') {
      const elevPanel = document.querySelector('.elev-graph') ||
        document.querySelector('.panel-elevation-profile');
      if (elevPanel) {
        elevPanel.click();
      }
    }
  });

  function setupGradientCircleObserver() {
    // Target the GRADE circle specifically, not the DRAFT circle
    const circle = document.querySelector('.panel-grade .stat-circle-fill, .stat-grade .stat-circle-fill');
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
    gradientCircleObserver = new MutationObserver(function (mutations) {
      // Skip if we're the ones making the change
      if (isUpdatingCircle) return;

      updateGradientCircleColor(circle);
    });

    // Watch style attribute changes on the circle fill
    gradientCircleObserver.observe(circle, {
      attributes: true,
      attributeFilter: ['style']
    });

    // Also watch for value text changes
    const valueElem = circle.parentElement?.querySelector('.stat-circle-value');
    if (valueElem) {
      gradientCircleObserver.observe(valueElem, {
        characterData: true,
        childList: true,
        subtree: true
      });
    }

    // Initial update (and a delayed one to catch race conditions)
    updateGradientCircleColor(circle);
    setTimeout(function () { updateGradientCircleColor(circle); }, 500);
  }

  function updateGradientCircleColor(circle) {
    if (!circle) {
      circle = document.querySelector('.panel-grade .stat-circle-fill, .stat-grade .stat-circle-fill');
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
      valueElem.style.setProperty('text-shadow',
        '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
        'important');

      // Clear guard after a brief delay (allow mutation to fire and be ignored)
      setTimeout(function () { isUpdatingCircle = false; }, 10);
    }
  }

})();
