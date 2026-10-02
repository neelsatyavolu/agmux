import AVFoundation
import Capacitor
import UIKit

/// `QRScanner.scan()` for the PWA: resolves `{ value }` with a scanned agmux
/// pairing link, or rejects with CANCELLED, DENIED or UNAVAILABLE.
@objc(QRScannerPlugin)
public class QRScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QRScannerPlugin"
    public let jsName = "QRScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard AVCaptureDevice.default(for: .video) != nil else {
                call.reject("No camera is available.", "UNAVAILABLE")
                return
            }
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                self.present(call)
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    DispatchQueue.main.async {
                        if granted { self.present(call) } else { call.reject("Camera access is off.", "DENIED") }
                    }
                }
            default:
                call.reject("Camera access is off.", "DENIED")
            }
        }
    }

    private func present(_ call: CAPPluginCall) {
        guard let host = bridge?.viewController else {
            call.reject("No camera is available.", "UNAVAILABLE")
            return
        }
        let scanner = QRScannerViewController()
        scanner.modalPresentationStyle = .fullScreen
        scanner.onFinish = { value in
            if let value { call.resolve(["value": value]) } else { call.reject("Scan cancelled.", "CANCELLED") }
        }
        host.present(scanner, animated: true)
    }
}
