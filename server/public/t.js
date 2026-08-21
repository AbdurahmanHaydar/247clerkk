/**
 * 247clerk visitor tracker.
 *
 *   <script async src="https://app.247clerk.com/t.js"></script>
 *
 * Drop it on any page. It records the page view, and it wires itself to every
 * "Try it on WhatsApp" link on the page: on click it stamps the link with the
 * visitor id so the token minted a moment later on /start belongs to the same
 * person, then beacons everything it knows.
 *
 * Everything is fire-and-forget. A failed beacon, a blocked ipify, a browser
 * with no localStorage — none of it may ever stand between a visitor and
 * WhatsApp, so every step is wrapped and every failure is silent.
 */
(function () {
  'use strict';

  var START = Date.now();

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    return all[all.length - 1];
  })();
  var ORIGIN = (function () {
    try { return new URL(script.src).origin; } catch (e) { return ''; }
  })();
  var ENDPOINT = ORIGIN + '/api/track';

  /* ------------------------------------------------------------ visitor id */

  function uuid() {
    try { return crypto.randomUUID(); } catch (e) {}
    return 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  var VID_KEY = '247clerk_vid';
  var visitorId = (function () {
    try {
      var existing = localStorage.getItem(VID_KEY);
      if (existing) return existing;
      var fresh = uuid();
      localStorage.setItem(VID_KEY, fresh);
      return fresh;
    } catch (e) {
      return uuid(); // Private mode. Still links the events within this page.
    }
  })();

  /* --------------------------------------------------------------- details */

  // ipify is asked once per tab and remembered, so the click beacon never waits
  // on a network round trip.
  var IP_KEY = '247clerk_ip';
  var publicIp = null;
  try { publicIp = sessionStorage.getItem(IP_KEY); } catch (e) {}

  if (!publicIp) {
    try {
      fetch('https://api.ipify.org?format=json', { mode: 'cors', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          publicIp = data && data.ip;
          try { sessionStorage.setItem(IP_KEY, publicIp); } catch (e) {}
        })
        .catch(function () {});
    } catch (e) {}
  }

  // Chromium hides the real browser and OS version behind client hints, and
  // only hands them over on request. Asked for once, up front.
  var uaData = null;
  try {
    if (navigator.userAgentData) {
      uaData = {
        mobile: navigator.userAgentData.mobile,
        brands: navigator.userAgentData.brands,
      };
      navigator.userAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platform', 'platformVersion',
        'uaFullVersion', 'fullVersionList', 'wow64',
      ]).then(function (high) {
        uaData = Object.assign(uaData || {}, high);
        var best = (high.fullVersionList || []).filter(function (b) {
          return !/Not.?A.?Brand/i.test(b.brand);
        }).pop();
        if (best) { uaData.brand = best.brand; uaData.uaFullVersion = best.version; }
      }).catch(function () {});
    }
  } catch (e) {}

  function params() {
    var out = {};
    try {
      new URL(location.href).searchParams.forEach(function (value, key) {
        if (/^(utm_|gclid|fbclid|msclkid|ref|src)/i.test(key)) out[key] = value.slice(0, 200);
      });
    } catch (e) {}
    return out;
  }

  function tokenFromPath() {
    var match = location.pathname.match(/\/s\/(CLK-[A-Za-z0-9]{6})/i);
    return match ? match[1].toUpperCase() : null;
  }

  function device() {
    var ua = navigator.userAgent || '';
    if (/iPad|Tablet|(Android(?!.*Mobile))/.test(ua)) return 'tablet';
    if (/Mobi|iPhone|iPod|Android/.test(ua) || (uaData && uaData.mobile)) return 'mobile';
    return 'desktop';
  }

  function collect() {
    var nav = navigator || {};
    var connection = nav.connection || nav.mozConnection || nav.webkitConnection || {};
    var d = {
      ip: publicIp,
      userAgent: nav.userAgent,
      uaData: uaData,
      device: device(),
      platform: nav.platform,
      vendor: nav.vendor,
      language: nav.language,
      languages: nav.languages,
      timezone: null,
      timezoneOffset: new Date().getTimezoneOffset(),
      screen: null,
      viewport: null,
      pixelRatio: window.devicePixelRatio,
      colorDepth: screen.colorDepth,
      orientation: (screen.orientation || {}).type,
      cpuCores: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory,
      touchPoints: nav.maxTouchPoints,
      cookiesEnabled: nav.cookieEnabled,
      doNotTrack: nav.doNotTrack,
      webdriver: nav.webdriver,
      pdfViewer: nav.pdfViewerEnabled,
      connection: {
        type: connection.effectiveType,
        downlink: connection.downlink,
        rtt: connection.rtt,
        saveData: connection.saveData,
      },
      darkMode: matchMedia('(prefers-color-scheme: dark)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      standalone: matchMedia('(display-mode: standalone)').matches,
      referrer: document.referrer || null,
      url: location.href,
      title: document.title,
      utm: params(),
      // How long they read before reaching for WhatsApp.
      secondsOnPage: Math.round((Date.now() - START) / 1000),
    };
    try { d.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    try { d.screen = screen.width + 'x' + screen.height; } catch (e) {}
    try { d.viewport = innerWidth + 'x' + innerHeight; } catch (e) {}
    return d;
  }

  /* ------------------------------------------------------------------ send */

  function send(kind, source, token) {
    var payload = JSON.stringify({
      kind: kind,
      source: source || null,
      token: token || tokenFromPath(),
      visitorId: visitorId,
      client: collect(),
    });
    try {
      // text/plain keeps it a simple request: no preflight, so a click never
      // waits for an OPTIONS round trip before WhatsApp opens.
      var blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return;
    } catch (e) {}
    try {
      fetch(ENDPOINT, { method: 'POST', body: payload, mode: 'cors', keepalive: true,
        headers: { 'content-type': 'text/plain;charset=UTF-8' } }).catch(function () {});
    } catch (e) {}
  }

  /* ----------------------------------------------------------------- wiring */

  function isStartLink(link) {
    var href = link.getAttribute('href') || '';
    return /\/start(\?|$)/.test(href) || /^https?:\/\/wa\.me\//.test(href);
  }

  function wire() {
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      (function (link, index) {
        if (!isStartLink(link) || link.__clerkWired) return;
        link.__clerkWired = true;
        var source = link.getAttribute('data-src') || (index === 0 ? 'hero' : 'cta-' + (index + 1));
        var whatsapp = /^https?:\/\/wa\.me\//.test(link.getAttribute('href') || '');

        link.addEventListener('click', function () {
          // Carry the visitor id across to app.247clerk.com so the token minted
          // by /start can be traced back to this exact click.
          if (!whatsapp) {
            try {
              var url = new URL(link.href, location.href);
              url.searchParams.set('vid', visitorId);
              if (!url.searchParams.get('src')) url.searchParams.set('src', source);
              link.href = url.toString();
            } catch (e) {}
          }
          send(whatsapp ? 'wa.click' : 'cta.click', source);
        }, { capture: true });
      })(links[i], i);
    }
  }

  send(tokenFromPath() ? 'session.view' : 'page.view', params().src || null);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
  // Links that appear later (the session page swaps views once connected).
  try { new MutationObserver(wire).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}

  window.clerkTrack = send;
})();
