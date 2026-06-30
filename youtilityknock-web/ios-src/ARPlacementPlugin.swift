import Foundation
import Capacitor
import ARKit

// Capacitor bridge for the in-app AR battery placement + capture.
//
//   ARPlacement.isSupported() -> { supported: Bool }
//   ARPlacement.capture({ modelName }) -> { photoBase64?: String, cancelled?: Bool }
//
// Registered with Capacitor via ARPlacementPlugin.m (CAP_PLUGIN macro), so it
// auto-loads without editing the generated bridge.
@objc(ARPlacementPlugin)
public class ARPlacementPlugin: CAPPlugin {

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": ARWorldTrackingConfiguration.isSupported])
    }

    @objc func capture(_ call: CAPPluginCall) {
        guard ARWorldTrackingConfiguration.isSupported else {
            call.resolve(["cancelled": true])
            return
        }
        let modelName = call.getString("modelName") ?? "battery"
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let presenter = self.bridge?.viewController else {
                call.resolve(["cancelled": true])
                return
            }
            let vc = ARPlacementViewController()
            vc.modelName = modelName
            vc.modalPresentationStyle = .fullScreen
            vc.completion = { base64 in
                if let b64 = base64 {
                    call.resolve(["photoBase64": b64])
                } else {
                    call.resolve(["cancelled": true])
                }
            }
            presenter.present(vc, animated: true, completion: nil)
        }
    }
}
