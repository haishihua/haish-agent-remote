import Foundation
import UserNotifications
import CryptoKit
import Capacitor

/// App-local notifications: no APNs entitlement or replacement icon is needed.
/// iOS displays the installed AppIcon automatically.
@objc(TaskNotifications)
public class TaskNotifications: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "TaskNotifications"
    public let jsName = "TaskNotifications"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "schedule", returnType: CAPPluginReturnPromise)
    ]
    private let historyKey = "haish.taskNotifications.delivered.v1"
    private var pending = Set<String>()

    public override func load() {
        bridge?.notificationRouter.localNotificationHandler = self
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error { call.reject("Could not request notification permission", nil, error); return }
            call.resolve(["granted": granted])
        }
    }

    @objc func schedule(_ call: CAPPluginCall) {
        guard let scope = call.getString("scope"), !scope.isEmpty,
              let taskId = call.getString("taskId"), !taskId.isEmpty,
              let conversationId = call.getString("conversationId"), !conversationId.isEmpty,
              let status = call.getString("status"), ["done", "failed"].contains(status) else {
            call.reject("Invalid task notification")
            return
        }
        // Length-prefixed scope prevents collisions; never persist device credentials.
        let identity = "\(scope.utf8.count):\(scope)\(taskId)"
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        let requestId = "haish.task.\(digest)"
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else {
                call.resolve(["scheduled": false])
                return
            }
            DispatchQueue.main.async {
                let history = UserDefaults.standard.stringArray(forKey: self.historyKey) ?? []
                guard !history.contains(requestId), !self.pending.contains(requestId) else {
                    call.resolve(["scheduled": false])
                    return
                }
                self.pending.insert(requestId)
                let content = UNMutableNotificationContent()
                content.title = status == "done" ? "任务完成" : "任务失败"
                content.body = String((call.getString("body") ?? "Haish task").prefix(160))
                content.sound = .default
                content.threadIdentifier = "haish.tasks"
                content.userInfo = ["scope": scope, "taskId": taskId, "conversationId": conversationId, "status": status]
                center.add(UNNotificationRequest(identifier: requestId, content: content, trigger: nil)) { error in
                    DispatchQueue.main.async {
                        self.pending.remove(requestId)
                        if let error { call.reject("Could not schedule task notification", nil, error); return }
                        // Read again because another task may have scheduled while add() was pending.
                        var delivered = UserDefaults.standard.stringArray(forKey: self.historyKey) ?? []
                        delivered.append(requestId)
                        UserDefaults.standard.set(Array(delivered.suffix(512)), forKey: self.historyKey)
                        call.resolve(["scheduled": true])
                    }
                }
            }
        }
    }

    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        guard notification.request.identifier.hasPrefix("haish.task.") else { return [] }
        return [.banner, .list, .sound]
    }

    public func didReceive(response: UNNotificationResponse) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              response.notification.request.identifier.hasPrefix("haish.task.") else { return }
        let data = response.notification.request.content.userInfo
        guard let scope = data["scope"] as? String,
              let conversationId = data["conversationId"] as? String else { return }
        // Keep a cold-start tap until the paired web app installs its listener.
        notifyListeners("taskNotificationAction", data: ["scope": scope, "conversationId": conversationId], retainUntilConsumed: true)
    }
}
