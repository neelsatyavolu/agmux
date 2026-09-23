/**
 * Capacitor-only helpers for agmux Remote iOS shell.
 * Safe no-op in plain Safari / PWA (Capacitor undefined).
 */
(function () {
  'use strict';

  function whenCapacitorReady(fn) {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      fn();
      return;
    }
    document.addEventListener(
      'deviceready',
      function () {
        if (window.Capacitor) fn();
      },
      { once: true },
    );
    // Capacitor injects after DOM; poll briefly
    var n = 0;
    var t = setInterval(function () {
      n += 1;
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
        clearInterval(t);
        fn();
      } else if (n > 40) {
        clearInterval(t);
      }
    }, 50);
  }

  function parsePairFromUrl(urlStr) {
    try {
      var u = new URL(urlStr);
      var hash = new URLSearchParams((u.hash || '').replace(/^#/, ''));
      var q = u.searchParams;
      var pair = hash.get('pair') || q.get('pair');
      var desktopId = hash.get('desktopId') || q.get('desktopId') || hash.get('desktop') || q.get('desktop');
      if (pair || desktopId) return { pair: pair || '', desktopId: desktopId || '' };
    } catch (_) {}
    return null;
  }

  function applyPair(params) {
    if (!params) return;
    // PWA already reads location.hash / search on boot; rewrite hash so existing boot path runs.
    var parts = [];
    if (params.pair) parts.push('pair=' + encodeURIComponent(params.pair));
    if (params.desktopId) parts.push('desktopId=' + encodeURIComponent(params.desktopId));
    if (!parts.length) return;
    var next = '#' + parts.join('&');
    if (location.hash !== next) {
      location.hash = next;
      // If boot already ran, dispatch a hashchange so pair UI can pick it up
      try {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (_) {
        window.dispatchEvent(new Event('hashchange'));
      }
    }
  }

  whenCapacitorReady(async function () {
    document.documentElement.classList.add('capacitor-native');
    try {
      var StatusBar = window.Capacitor.Plugins.StatusBar;
      if (StatusBar) {
        await StatusBar.setStyle({ style: 'DARK' });
        // Overlay so the PWA's viewport-fit=cover + safe-area insets own the top edge
        if (StatusBar.setOverlaysWebView) {
          await StatusBar.setOverlaysWebView({ overlay: true });
        }
      }
    } catch (e) {
      console.warn('[native-bridge] StatusBar', e);
    }

    try {
      var App = window.Capacitor.Plugins.App;
      if (App && App.addListener) {
        App.addListener('appUrlOpen', function (data) {
          if (data && data.url) applyPair(parsePairFromUrl(data.url));
        });
        // Cold start via custom scheme / universal link
        if (App.getLaunchUrl) {
          var launch = await App.getLaunchUrl();
          if (launch && launch.url) applyPair(parsePairFromUrl(launch.url));
        }
      }
    } catch (e) {
      console.warn('[native-bridge] App url', e);
    }
  });
})();
