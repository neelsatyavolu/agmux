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

  /** A switch from the PWA's Settings (localStorage "agmux-remote-prefs"); all default on. */
  function prefOn(key) {
    try {
      return JSON.parse(localStorage.getItem('agmux-remote-prefs') || '{}')[key] !== false;
    } catch (_) {
      return true;
    }
  }

  function notificationId(tag) {
    var h = 0;
    for (var i = 0; i < tag.length; i += 1) h = (h * 31 + tag.charCodeAt(i)) | 0;
    return (Math.abs(h) % 2147483646) + 1;
  }

  /**
   * WKWebView has no Web Notifications. Back window.Notification with iOS local
   * notifications so the PWA's alerts (notifyBlocked / notifyFinished) work as-is.
   * Returns a function that re-reads the permission (it can change in Settings).
   */
  function installNotifications(LocalNotifications) {
    var permission = 'default';
    var shown = {};
    function fromDisplay(display) {
      return display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'default';
    }
    function refresh() {
      return LocalNotifications.checkPermissions().then(
        function (r) { permission = fromDisplay(r.display); },
        function () {},
      );
    }
    function NativeNotification(title, options) {
      var opts = options || {};
      var id = notificationId(String(opts.tag || title + Date.now()));
      this.onclick = null;
      this.close = function () {
        LocalNotifications.cancel({ notifications: [{ id: id }] }).catch(function () {});
      };
      shown[id] = this;
      LocalNotifications.schedule({
        notifications: [{ id: id, title: String(title), body: String(opts.body || ''), extra: opts.data || null }],
      }).catch(function (e) { console.warn('[native-bridge] notification', e); });
    }
    Object.defineProperty(NativeNotification, 'permission', { get: function () { return permission; } });
    NativeNotification.requestPermission = function () {
      return LocalNotifications.requestPermissions().then(
        function (r) { permission = fromDisplay(r.display); return permission; },
        function () { return permission; },
      );
    };
    LocalNotifications.addListener('localNotificationActionPerformed', function (event) {
      var n = event && event.notification;
      var target = n && shown[n.id];
      if (target && typeof target.onclick === 'function') target.onclick();
      else if (n && n.extra && n.extra.threadId && typeof window.openThread === 'function') window.openThread(n.extra.threadId);
    });
    window.Notification = NativeNotification;
    return refresh;
  }

  whenCapacitorReady(async function () {
    document.documentElement.classList.add('capacitor-native');

    var refreshNotifications = function () { return Promise.resolve(); };
    var LocalNotifications = window.Capacitor.Plugins.LocalNotifications;
    if (LocalNotifications && typeof window.Notification === 'undefined') {
      refreshNotifications = installNotifications(LocalNotifications);
      refreshNotifications();
    }
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

    // Push from the relay (APNs) so alerts arrive while the app is closed.
    var Push = window.Capacitor.Plugins.PushNotifications;
    var registerPush = function () {};
    if (Push) {
      Push.addListener('registration', function (t) {
        if (t && t.value && typeof window.setPushToken === 'function') window.setPushToken(t.value);
      });
      Push.addListener('registrationError', function (e) { console.warn('[native-bridge] push registration', e); });
      Push.addListener('pushNotificationActionPerformed', function (action) {
        var data = action && action.notification && action.notification.data;
        if (data && data.threadId && typeof window.openThreadWhenReady === 'function') window.openThreadWhenReady(data.threadId);
      });
      // Registering needs notification permission; it is asked from Settings or the first send.
      registerPush = function () {
        Push.checkPermissions().then(function (p) {
          if (p.receive === 'granted') return Push.register();
        }).catch(function (e) { console.warn('[native-bridge] push', e); });
      };
      registerPush();
      if (window.Notification && window.Notification.requestPermission) {
        var askPermission = window.Notification.requestPermission;
        window.Notification.requestPermission = function () {
          return askPermission().then(function (result) { registerPush(); return result; });
        };
      }
    }

    try {
      var App = window.Capacitor.Plugins.App;
      if (App && App.addListener) {
        App.addListener('appUrlOpen', function (data) {
          if (data && data.url) applyPair(parsePairFromUrl(data.url));
        });
        // iOS suspends the socket in the background. The PWA's resumeIfDead()
        // listens for pageshow, so reconnect the moment the app is back.
        // Notification permission is re-read first so an open Settings sheet shows it.
        // The relay only pushes to phones that aren't looking at agmux.
        App.addListener('pause', function () {
          if (typeof window.setAppState === 'function') window.setAppState('background');
        });
        App.addListener('resume', function () {
          if (typeof window.setAppState === 'function') window.setAppState('foreground');
          registerPush();
          refreshNotifications().then(function () {
            window.dispatchEvent(new Event('pageshow'));
          });
        });
        if (App.getInfo) {
          App.getInfo().then(function (info) {
            var el = document.getElementById('prefsVersion');
            if (el) el.textContent = info.version + ' (' + info.build + ')';
          }).catch(function () {});
        }
        // Cold start via custom scheme / universal link
        if (App.getLaunchUrl) {
          var launch = await App.getLaunchUrl();
          if (launch && launch.url) applyPair(parsePairFromUrl(launch.url));
        }
      }
    } catch (e) {
      console.warn('[native-bridge] App url', e);
    }

    // In-app QR scanner (QRScannerPlugin.swift) on the pairing screen.
    var Scanner = window.Capacitor.registerPlugin ? window.Capacitor.registerPlugin('QRScanner') : null;
    var scanBtn = document.getElementById('scanBtn');
    var scanErr = document.getElementById('scanErr');
    if (Scanner && scanBtn) {
      var stage = document.getElementById('stage');
      if (stage) stage.setAttribute('data-scan', '1');
      var SCAN_ERRORS = {
        DENIED: 'Camera access is off. Turn it on in Settings → agmux, or enter the desktop ID and pair code below.',
        UNAVAILABLE: 'This iPhone can’t use the camera right now. Enter the desktop ID and pair code below.',
      };
      scanBtn.addEventListener('click', function () {
        if (scanErr) scanErr.hidden = true;
        Scanner.scan().then(function (result) {
          applyPair(parsePairFromUrl(result && result.value));
        }, function (e) {
          var code = e && e.code;
          if (code === 'CANCELLED' || !scanErr) return;
          scanErr.textContent = SCAN_ERRORS[code] || SCAN_ERRORS.UNAVAILABLE;
          scanErr.hidden = false;
        });
      });
    }

    // A light tap confirms approval answers, like native iOS buttons.
    var Haptics = window.Capacitor.Plugins.Haptics;
    if (Haptics && Haptics.impact) {
      document.addEventListener('click', function (e) {
        var target = e.target && e.target.closest && e.target.closest('#allowBtn, #denyBtn');
        if (target && prefOn('haptics')) Haptics.impact({ style: 'MEDIUM' }).catch(function () {});
      }, true);
    }
  });
})();
