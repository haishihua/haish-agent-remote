import WebKit
import Capacitor

/// Capacitor owns a single WKWebView for the lifetime of the app. Keep that same controller and
/// let WebKit drive its native interactive back transition; the web app supplies one history item
/// for each open conversation and handles `popstate` by removing only the detail overlay.
final class HaishBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
    }
}
