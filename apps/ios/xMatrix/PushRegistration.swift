import UIKit
import UserNotifications

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

/// A tap on a notification can be what starts the app, before there is a page
/// to open its conversation in. The tap is kept until the page is ready.
@MainActor
final class NotificationTaps {
    static let shared = NotificationTaps()

    private var pending: [AnyHashable: Any]?
    private var open: (([AnyHashable: Any]) -> Void)?

    func tapped(_ userInfo: [AnyHashable: Any]) {
        if let open {
            open(userInfo)
        } else {
            pending = userInfo
        }
    }

    /// Names where taps go from now on, and hands over one that came first.
    func deliver(to open: @escaping ([AnyHashable: Any]) -> Void) {
        self.open = open
        if let waiting = pending {
            pending = nil
            open(waiting)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    // iOS hands a tap that starts the app only to a delegate that is set by the
    // end of launch; one set later, when the page is built, never hears of it.
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // While the app is open the web app posts the same message itself; a pushed copy would show it twice.
        if notification.request.trigger is UNPushNotificationTrigger {
            return []
        }
        return [.banner, .list, .sound, .badge]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        await MainActor.run {
            NotificationTaps.shared.tapped(userInfo)
        }
    }

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
