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
    private var keyboardFrameObservers: [NSObjectProtocol] = []

    deinit {
        keyboardFrameObservers.forEach { NotificationCenter.default.removeObserver($0) }
    }

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
        // AppDelegate's bridge eval is queued through Capacitor and can arrive after UIKit has
        // already begun moving the keyboard. Listen in the bridge controller instead and evaluate
        // directly on this WKWebView so the composer transform starts in the same run-loop turn.
        keyboardFrameObservers = [
            NotificationCenter.default.addObserver(
                forName: UIResponder.keyboardWillChangeFrameNotification,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                // NotificationCenter's main-queue delivery is synchronous when UIKit posts on main;
                // run the actor-isolated WebView call in that same turn instead of adding a Task hop.
                MainActor.assumeIsolated {
                    self?.forwardKeyboardFrame(notification, dismissal: false)
                }
            },
            NotificationCenter.default.addObserver(
                forName: UIResponder.keyboardWillHideNotification,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                MainActor.assumeIsolated {
                    self?.forwardKeyboardFrame(notification, dismissal: true)
                }
            },
            NotificationCenter.default.addObserver(
                forName: UIResponder.keyboardDidShowNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.pinWebViewOffset()
                }
            },
            NotificationCenter.default.addObserver(
                forName: UIResponder.keyboardDidHideNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.pinWebViewOffset()
                }
            }
        ]
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

    private func pinWebViewOffset() {
        guard let scrollView = webView?.scrollView, scrollView.contentOffset != .zero else { return }
        scrollView.setContentOffset(.zero, animated: false)
    }

    private func forwardKeyboardFrame(_ notification: Notification, dismissal: Bool) {
        guard let webView else { return }
        let duration = (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0
        var height = 0
        var lift = 0
        var fromLift = 0
        if let window = webView.window {
            let screen = window.bounds
            let coveredHeight: (NSValue?) -> CGFloat = { value in
                guard let value else { return 0 }
                let keyboard = window.convert(value.cgRectValue, from: window.screen.coordinateSpace)
                return keyboard.minY < screen.maxY ? max(0, min(keyboard.height, screen.maxY - keyboard.minY)) : 0
            }
            let beginCovered = coveredHeight(notification.userInfo?[UIResponder.keyboardFrameBeginUserInfoKey] as? NSValue)
            let endCovered = dismissal ? 0 : coveredHeight(notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)
            let restingGap = max(12, 8 + window.safeAreaInsets.bottom)
            height = Int(endCovered.rounded())
            // UIKit gives both ends of the transition. Forward both native positions so an
            // interrupted input-method switch starts from its real pixel without a DOM style read.
            fromLift = Int(max(0, beginCovered + 12 - restingGap).rounded())
            lift = Int(max(0, endCovered + 12 - restingGap).rounded())
        }
        // A zero will-change frame is not necessarily a hide: input-method replacement and
        // floating/undocked keyboard transitions can pass through a non-covering frame while the
        // textarea stays first responder. Only the dedicated will-hide notification may dismiss.
        //
        // `at` is the moment UIKit posted this notification, on the same wall clock the page reads
        // with `Date.now()`. The page hears about the keyboard only after the bridge hop, while the
        // keyboard window started moving in this very run-loop turn; without the timestamp the
        // composed travel starts from the wrong end of the animation and the composer spends the
        // first half of the rise behind the keyboard. src/ios-keyboard.js anchors to it instead.
        let at = String(format: "%.1f", Date().timeIntervalSince1970 * 1000)
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('haishKeyboardFrame', { detail: { height: \(height), fromLift: \(fromLift), lift: \(lift), duration: \(duration), dismissal: \(dismissal), at: \(at) } }))")
    }
}
