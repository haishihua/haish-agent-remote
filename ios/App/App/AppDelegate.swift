import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Capacitor loads bridged plugins by class name, which a release build's dead-code
        // stripping cannot see, so keep the app-local photo picker plugin linked in.
        _ = PhotoPicker.self
        // 键盘 frame 变了要告诉 Web 层。换输入法（系统键盘 ↔ 第三方输入法、emoji、系统键盘上多一条提示栏）
        // 时 iOS 常常只发 `UIKeyboardWillChangeFrameNotification`，不发 will/didShow；Capacitor 的 Keyboard
        // 插件只订阅了后者，Web 层就一直以为键盘还是上一把的高度（现场：输入框浮在键盘上方一百多点，用户报
        // 的「切换键盘，输入框又往上跑」）。这里只把高度原样转过去，怎么动由 src/ios-keyboard.js 决定。
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil)
        // Override point for customization after application launch.
        return true
    }

    /// 报的是键盘在屏幕上真正盖住的高度（点）。键盘整个挪到屏幕外（收起、或者挂了外接键盘）时报 0，
    /// Web 层按收起处理——和 `keyboardWillHide` 是同一条路。
    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        guard let value = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue,
              let window = window,
              let bridge = (window.rootViewController as? CAPBridgeViewController)?.bridge else { return }
        let keyboard = value.cgRectValue
        let screen = window.bounds
        let covered = keyboard.minY < screen.maxY ? min(keyboard.height, screen.maxY - keyboard.minY) : 0
        let height = Int(max(0, covered).rounded())
        bridge.eval(js: "window.dispatchEvent(new CustomEvent('haishKeyboardFrame', { detail: { height: \(height) } }))")
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}
