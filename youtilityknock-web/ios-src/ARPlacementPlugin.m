#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift ARPlacementPlugin with Capacitor's runtime so the JS
// side can call registerPlugin("ARPlacement"). Capacitor discovers plugins
// declared with this macro automatically — no edit to the generated bridge.
CAP_PLUGIN(ARPlacementPlugin, "ARPlacement",
  CAP_PLUGIN_METHOD(isSupported, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(capture, CAPPluginReturnPromise);
)
