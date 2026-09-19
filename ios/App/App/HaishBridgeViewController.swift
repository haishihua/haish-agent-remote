import UIKit
import WebKit
import Capacitor

/// A public-API responder in the WKWebView chain. UIKit asks the responder chain which custom
/// edit-menu commands are available, so no private WebKit view inspection is needed. JavaScript
/// still owns selection validation and the annotation draft itself.
final class HaishWebView: WKWebView {
    static let addCommentEvent = "haishNativeAddComment"
    var annotationSelectionAvailable = false {
        didSet {
            guard annotationSelectionAvailable != oldValue else { return }
            if #available(iOS 16.0, *) {
                UIMenuSystem.context.setNeedsRebuild()
            } else {
                UIMenuController.shared.update()
            }
        }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(addComment(_:)) { return annotationSelectionAvailable }
        return super.canPerformAction(action, withSender: sender)
    }

    @objc func addComment(_ sender: Any?) {
        evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(Self.addCommentEvent)'))")
    }
}

/// The page reports whether its current selection belongs to an annotatable assistant answer. This
/// keeps Add Comment out of input fields and unrelated native edit menus while UIKit owns the menu.
final class HaishAnnotationSelectionHandler: NSObject, WKScriptMessageHandler {
    weak var webView: HaishWebView?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        webView?.annotationSelectionAvailable = message.body as? Bool ?? false
    }
}

/// Capacitor owns a single WKWebView for the lifetime of the app. Keep that same controller and
/// let WebKit drive native navigation and text-selection UI; the web app supplies navigation state
/// and turns the native Add Comment command into an annotation draft.
final class HaishBridgeViewController: CAPBridgeViewController {
    private let annotationSelectionHandler = HaishAnnotationSelectionHandler()

    /// iOS 16 replaced UIMenuController-backed text menus with UIEditMenuInteraction. Adding a
    /// command through the public menu builder keeps it inside WebKit's native Copy/Look Up menu.
    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard #available(iOS 16.0, *),
              (webView as? HaishWebView)?.annotationSelectionAvailable == true else { return }

        let action = UIAction(title: "Add Comment") { [weak self] _ in
            (self?.webView as? HaishWebView)?.addComment(nil)
        }
        let menu = UIMenu(title: "", options: .displayInline, children: [action])
        builder.insertSibling(menu, afterMenu: .standardEdit)
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        let result = HaishWebView(frame: frame, configuration: configuration)
        annotationSelectionHandler.webView = result
        configuration.userContentController.add(annotationSelectionHandler, name: "haishAnnotationSelection")
        return result
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
        // iOS 15 still uses UIMenuController for WebKit's selection menu. iOS 16+ is handled by
        // buildMenu(with:) above, avoiding the deprecated path on modern systems.
        if #available(iOS 16.0, *) {
            UIMenuController.shared.menuItems = nil
        } else {
            UIMenuController.shared.menuItems = [
                UIMenuItem(title: "Add Comment", action: #selector(HaishWebView.addComment(_:)))
            ]
        }
    }
}
