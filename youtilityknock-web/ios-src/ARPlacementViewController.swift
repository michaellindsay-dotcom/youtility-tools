import UIKit
import ARKit
import SceneKit

// Full-screen AR placement + capture, presented by ARPlacementPlugin.
//
// Flow: detect a surface (coaching overlay guides the user) → tap to drop the
// battery model on it → drag to move, pinch to resize, two-finger rotate →
// tap "Capture" to snapshot the live AR scene (camera feed + model composited)
// and hand the JPEG back to JS. "Cancel" dismisses with no result.
//
// The model is the same battery.usdz the web app ships: Vite copies
// public/battery.usdz into the build, and Capacitor bundles the web output
// under <App>.app/public, so the file is found at public/battery.usdz.
class ARPlacementViewController: UIViewController, ARSCNViewDelegate, ARCoachingOverlayViewDelegate, UIGestureRecognizerDelegate {

    var modelName: String = "battery"
    var completion: ((String?) -> Void)?

    private let sceneView = ARSCNView()
    private let coachingOverlay = ARCoachingOverlayView()
    private var modelNode: SCNNode?
    private var placed = false
    private var baseScale: SCNVector3 = SCNVector3(1, 1, 1)

    private let hint = UILabel()
    private let captureButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        sceneView.frame = view.bounds
        sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        sceneView.delegate = self
        sceneView.automaticallyUpdatesLighting = true
        sceneView.autoenablesDefaultLighting = true
        view.addSubview(sceneView)

        setupCoaching()
        setupUI()
        setupGestures()
        loadModel()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal, .vertical]
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sceneView.session.pause()
    }

    override var prefersStatusBarHidden: Bool { true }

    // MARK: - Setup

    private func setupCoaching() {
        coachingOverlay.session = sceneView.session
        coachingOverlay.delegate = self
        coachingOverlay.activatesAutomatically = true
        coachingOverlay.goal = .horizontalPlane
        coachingOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(coachingOverlay)
        NSLayoutConstraint.activate([
            coachingOverlay.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            coachingOverlay.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            coachingOverlay.widthAnchor.constraint(equalTo: view.widthAnchor),
            coachingOverlay.heightAnchor.constraint(equalTo: view.heightAnchor),
        ])
    }

    private func setupUI() {
        hint.text = "Move your phone to find a surface, then tap to place the battery."
        hint.textColor = .white
        hint.font = .systemFont(ofSize: 15, weight: .medium)
        hint.numberOfLines = 0
        hint.textAlignment = .center
        hint.shadowColor = .black
        hint.shadowOffset = CGSize(width: 0, height: 1)
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)

        captureButton.setTitle("Capture", for: .normal)
        captureButton.titleLabel?.font = .systemFont(ofSize: 18, weight: .semibold)
        captureButton.setTitleColor(.white, for: .normal)
        captureButton.backgroundColor = UIColor(red: 0.05, green: 0.65, blue: 0.91, alpha: 1.0)
        captureButton.layer.cornerRadius = 14
        captureButton.contentEdgeInsets = UIEdgeInsets(top: 14, left: 28, bottom: 14, right: 28)
        captureButton.translatesAutoresizingMaskIntoConstraints = false
        captureButton.addTarget(self, action: #selector(onCapture), for: .touchUpInside)
        captureButton.isEnabled = false
        captureButton.alpha = 0.4
        view.addSubview(captureButton)

        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .medium)
        cancelButton.setTitleColor(.white, for: .normal)
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.addTarget(self, action: #selector(onCancel), for: .touchUpInside)
        view.addSubview(cancelButton)

        NSLayoutConstraint.activate([
            hint.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            hint.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),

            captureButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            captureButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),

            cancelButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            cancelButton.centerYAnchor.constraint(equalTo: captureButton.centerYAnchor),
        ])
    }

    private func setupGestures() {
        let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
        sceneView.addGestureRecognizer(tap)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
        pan.delegate = self
        sceneView.addGestureRecognizer(pan)

        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
        pinch.delegate = self
        sceneView.addGestureRecognizer(pinch)

        let rotate = UIRotationGestureRecognizer(target: self, action: #selector(onRotate(_:)))
        rotate.delegate = self
        sceneView.addGestureRecognizer(rotate)
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        return true
    }

    private func loadModel() {
        var url = Bundle.main.url(forResource: modelName, withExtension: "usdz", subdirectory: "public")
        if url == nil { url = Bundle.main.url(forResource: modelName, withExtension: "usdz") }
        guard let modelUrl = url, let scene = try? SCNScene(url: modelUrl, options: nil) else {
            hint.text = "Couldn't load the 3D model."
            return
        }
        let node = SCNNode()
        for child in scene.rootNode.childNodes { node.addChildNode(child) }
        // Normalize so the model stands ~0.45m tall regardless of source units.
        let (minB, maxB) = node.boundingBox
        let height = maxB.y - minB.y
        if height > 0.0001 {
            let s = 0.45 / height
            node.scale = SCNVector3(s, s, s)
        }
        baseScale = node.scale
        node.isHidden = true
        modelNode = node
        sceneView.scene.rootNode.addChildNode(node)
    }

    // MARK: - Placement

    @objc private func onTap(_ g: UITapGestureRecognizer) {
        guard let model = modelNode else { return }
        let point = g.location(in: sceneView)
        guard let pos = worldPosition(at: point) else { return }
        model.position = pos
        model.isHidden = false
        if !placed {
            placed = true
            captureButton.isEnabled = true
            captureButton.alpha = 1.0
            hint.text = "Drag to move · pinch to resize · rotate with two fingers · tap Capture."
        }
    }

    @objc private func onPan(_ g: UIPanGestureRecognizer) {
        guard placed, let model = modelNode else { return }
        let point = g.location(in: sceneView)
        if let pos = worldPosition(at: point) { model.position = pos }
    }

    @objc private func onPinch(_ g: UIPinchGestureRecognizer) {
        guard placed, let model = modelNode else { return }
        let s = Float(g.scale)
        model.scale = SCNVector3(model.scale.x * s, model.scale.y * s, model.scale.z * s)
        g.scale = 1.0
    }

    @objc private func onRotate(_ g: UIRotationGestureRecognizer) {
        guard placed, let model = modelNode else { return }
        model.eulerAngles.y -= Float(g.rotation)
        g.rotation = 0
    }

    // Raycast against detected planes (fall back to feature points / estimate).
    private func worldPosition(at point: CGPoint) -> SCNVector3? {
        if let q = sceneView.raycastQuery(from: point, allowing: .existingPlaneGeometry, alignment: .any),
           let r = sceneView.session.raycast(q).first {
            let t = r.worldTransform
            return SCNVector3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        }
        if let q = sceneView.raycastQuery(from: point, allowing: .estimatedPlane, alignment: .any),
           let r = sceneView.session.raycast(q).first {
            let t = r.worldTransform
            return SCNVector3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        }
        return nil
    }

    // MARK: - Actions

    @objc private func onCapture() {
        // Hide UI chrome so it isn't baked into the photo.
        let wasHidden = (hint.isHidden, captureButton.isHidden, cancelButton.isHidden, coachingOverlay.isHidden)
        hint.isHidden = true
        captureButton.isHidden = true
        cancelButton.isHidden = true
        coachingOverlay.isHidden = true

        let image = sceneView.snapshot()

        hint.isHidden = wasHidden.0
        captureButton.isHidden = wasHidden.1
        cancelButton.isHidden = wasHidden.2
        coachingOverlay.isHidden = wasHidden.3

        let base64 = image.jpegData(compressionQuality: 0.85)?.base64EncodedString()
        finish(with: base64)
    }

    @objc private func onCancel() {
        finish(with: nil)
    }

    private func finish(with base64: String?) {
        let done = completion
        completion = nil
        dismiss(animated: true) { done?(base64) }
    }
}
