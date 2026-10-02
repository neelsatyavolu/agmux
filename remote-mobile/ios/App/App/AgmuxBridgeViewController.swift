import UIKit
import WebKit
import Capacitor

/// Capacitor's bridge with the pairing kept in the Keychain (see PairingPersistence).
final class AgmuxBridgeViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        PairingPersistence.install(into: configuration.userContentController)
        return configuration
    }
}
