import UIKit
import WebKit
import Capacitor

/// Capacitor's bridge with the pairing kept in the Keychain (see PairingPersistence)
/// and the app's own QR scanner plugin.
final class AgmuxBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(QRScannerPlugin())
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        PairingPersistence.install(into: configuration.userContentController)
        return configuration
    }
}
