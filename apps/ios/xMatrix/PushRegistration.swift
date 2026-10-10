import UIKit

/// This device's address at Apple's push service. Asked for once, when the web app first wants it.
@MainActor
final class PushRegistration {
    static let shared = PushRegistration()

    private var token: String?
    private var waiters: [CheckedContinuation<String?, Never>] = []

    /// The device token as hexadecimal, or nil when Apple would not give one.
    func deviceToken() async -> String? {
        if let token {
            return token
        }
        return await withCheckedContinuation { continuation in
            waiters.append(continuation)
            if waiters.count == 1 {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func registered(_ deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
        settle(token)
    }

    func failed() {
        settle(nil)
    }

    private func settle(_ value: String?) {
        let waiting = waiters
        waiters = []
        for continuation in waiting {
            continuation.resume(returning: value)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            PushRegistration.shared.registered(deviceToken)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in
            PushRegistration.shared.failed()
        }
    }
}
