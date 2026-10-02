import AVFoundation
import UIKit

/// Full-screen camera that scans for an agmux pairing QR code.
/// Calls `onFinish` once: the scanned text, or nil when the user cancels.
final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onFinish: ((String?) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "dev.agmux.remote.qr-session")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let hint = UILabel()
    private var finished = false
    private var lastRejected: String?

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
        buildOverlay()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sessionQueue.async { [session] in if !session.isRunning { session.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [session] in if session.isRunning { session.stopRunning() } }
    }

    private func configureSession() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            showHint("The camera isn't available.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        previewLayer = layer
    }

    private func buildOverlay() {
        let frame = UIView()
        frame.layer.borderColor = UIColor.white.withAlphaComponent(0.9).cgColor
        frame.layer.borderWidth = 3
        frame.layer.cornerRadius = 22
        frame.isUserInteractionEnabled = false
        frame.translatesAutoresizingMaskIntoConstraints = false

        hint.text = "Point at the QR code in agmux → Settings → Remote control on your Mac."
        hint.textColor = .white
        hint.font = .preferredFont(forTextStyle: .body)
        hint.adjustsFontForContentSizeCategory = true
        hint.numberOfLines = 0
        hint.textAlignment = .center
        hint.translatesAutoresizingMaskIntoConstraints = false

        var config = UIButton.Configuration.filled()
        config.title = "Cancel"
        config.baseBackgroundColor = UIColor.white.withAlphaComponent(0.18)
        config.baseForegroundColor = .white
        config.cornerStyle = .capsule
        let cancel = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.finish(nil) })
        cancel.translatesAutoresizingMaskIntoConstraints = false

        [frame, hint, cancel].forEach(view.addSubview)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            frame.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            frame.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -40),
            frame.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.68),
            frame.heightAnchor.constraint(equalTo: frame.widthAnchor),
            hint.topAnchor.constraint(equalTo: frame.bottomAnchor, constant: 28),
            hint.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 32),
            hint.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -32),
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -24),
            cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
            cancel.widthAnchor.constraint(greaterThanOrEqualToConstant: 140),
        ])
    }

    private func showHint(_ text: String) {
        hint.text = text
        UIAccessibility.post(notification: .announcement, argument: text)
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !finished,
              let text = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        if PairLink.isPairLink(text) {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            finish(text)
        } else if text != lastRejected {
            lastRejected = text
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            showHint("That QR code isn't an agmux pairing code. Open agmux → Settings → Remote control on your Mac.")
        }
    }

    private func finish(_ result: String?) {
        guard !finished else { return }
        finished = true
        sessionQueue.async { [session] in session.stopRunning() }
        dismiss(animated: true) { [onFinish] in onFinish?(result) }
    }
}
