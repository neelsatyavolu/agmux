import Foundation
import WebKit

/// Keeps the PWA's pairing (`localStorage["agmux-remote-auth"]`) in the Keychain.
///
/// iOS may clear a web view's storage, which would silently unpair the phone.
/// A document-start script restores the saved value before any page script
/// runs, and reports every later change back so the Keychain stays current.
enum PairingPersistence {
    static let storageKey = "agmux-remote-auth"
    static let handlerName = "agmuxPairing"

    static let store = KeychainStore(service: "dev.agmux.remote.pairing", account: storageKey)

    static func install(into controller: WKUserContentController) {
        controller.add(MessageHandler(), name: handlerName)
        let script = WKUserScript(
            source: userScript(saved: store.read()),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        controller.addUserScript(script)
    }

    /// Builds the document-start script. `saved` is embedded as a JSON literal.
    static func userScript(saved: String?) -> String {
        let savedLiteral = saved.flatMap(jsonStringLiteral) ?? "null"
        return """
        (function () {
          var KEY = \(jsonStringLiteral(storageKey) ?? "''");
          var saved = \(savedLiteral);
          var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName);
          function report(value) {
            try { if (handler) handler.postMessage(value === null ? { op: 'remove' } : { op: 'set', value: String(value) }); } catch (e) {}
          }
          try {
            var current = window.localStorage.getItem(KEY);
            if (current === null && saved !== null) window.localStorage.setItem(KEY, saved);
            else if (current !== null && current !== saved) report(current);
          } catch (e) {}
          var proto = Storage.prototype;
          var setItem = proto.setItem, removeItem = proto.removeItem, clear = proto.clear;
          proto.setItem = function (k, v) {
            setItem.call(this, k, v);
            if (this === window.localStorage && k === KEY) report(v);
          };
          proto.removeItem = function (k) {
            removeItem.call(this, k);
            if (this === window.localStorage && k === KEY) report(null);
          };
          proto.clear = function () {
            clear.call(this);
            if (this === window.localStorage) report(null);
          };
        })();
        """
    }

    private static func jsonStringLiteral(_ value: String) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private final class MessageHandler: NSObject, WKScriptMessageHandler {
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the bundled app page (capacitor://localhost) may change the pairing.
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, origin.protocol == "capacitor", origin.host == "localhost",
                  let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
            switch op {
            case "set":
                if let value = body["value"] as? String { store.write(value) }
            case "remove":
                store.delete()
            default:
                break
            }
        }
    }
}
