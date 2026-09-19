import Foundation
import UIKit
import Capacitor

/// Native step feedback for the composer's discrete reasoning control.
/// UIKit's impact styles make higher reasoning levels feel progressively firmer.
@objc(ReasoningHaptics)
public class ReasoningHaptics: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReasoningHaptics"
    public let jsName = "ReasoningHaptics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "impact", returnType: CAPPluginReturnPromise)
    ]

    @objc func impact(_ call: CAPPluginCall) {
        let requested = (call.getString("style") ?? "light").lowercased()
        let style: UIImpactFeedbackGenerator.FeedbackStyle
        switch requested {
        case "medium":
            style = .medium
        case "heavy":
            style = .heavy
        case "rigid":
            if #available(iOS 13.0, *) { style = .rigid } else { style = .heavy }
        default:
            style = .light
        }

        DispatchQueue.main.async {
            let generator = UIImpactFeedbackGenerator(style: style)
            generator.prepare()
            generator.impactOccurred()
            call.resolve()
        }
    }
}
