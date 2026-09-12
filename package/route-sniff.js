// Biketerra Gradient Colors - route ID sniffer (main world)
//
// The ride page is client-rendered, so the app fetches its own route payload on
// the way in, with the route ID right there in the request URL. Reading the ID
// out of the DOM instead is unreliable: `.route-id` only exists while the route
// menu is on screen, so with the menu closed there is nothing to find and the
// recolouring never starts.
//
// content.js runs in the isolated world and cannot see the page's fetch, so the
// catching has to happen here, at document_start, and cross over by postMessage.

(function () {
  'use strict';

  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;

  let lastRouteId = null;

  function announce() {
    if (!lastRouteId) return;
    window.postMessage(
      { source: 'bt-gradient-colors-route', routeId: lastRouteId },
      window.location.origin
    );
  }

  // content.js only starts listening at document_idle, by which time the page's
  // request may already have gone past, so it pings once it is ready.
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.source === 'bt-gradient-colors-ping') announce();
  });

  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : input && input.url;
    if (typeof url === 'string' && url.indexOf('__data.json') !== -1) {
      // the ID is in the URL, so there is no need to wait for the response
      const match = url.match(/[?&]route=(\d+)/);
      if (match && match[1] !== lastRouteId) {
        lastRouteId = match[1];
        announce();
      }
    }
    return nativeFetch.apply(this, arguments);
  };
})();
