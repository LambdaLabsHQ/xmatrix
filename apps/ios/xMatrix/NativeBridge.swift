import UIKit
import UserNotifications
import WebKit

final class NativeBridge: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    weak var webView: WKWebView?
    var onMobileTabStateChanged: ((MobileTabState) -> Void)?
    var onOpenURL: ((URL) -> Void)?
    private static let notificationURLKey = "xmatrix.url"
    private static let notificationChannelIDKey = "xmatrix.channelId"

    static let injectionScript = """
    (() => {
      if (window.xmatrixDesktop || !window.webkit?.messageHandlers?.xmatrixNative) return;

      const pending = new Map();
      let nextId = 1;

      window.__xmatrixNativeResolve = (id, ok, value) => {
        const callbacks = pending.get(id);
        if (!callbacks) return;
        pending.delete(id);
        ok ? callbacks.resolve(value) : callbacks.reject(new Error(String(value || "Native bridge error")));
      };

      const invoke = (method, payload) => new Promise((resolve, reject) => {
        const id = String(nextId++);
        pending.set(id, { resolve, reject });
        window.webkit.messageHandlers.xmatrixNative.postMessage({ id, method, payload });
      });

      const disabledUpdateStatus = () => ({
        state: "disabled",
        enabled: false,
        currentVersion: "0.1.0",
        message: "Automatic updates are unavailable on iOS.",
        updatedAt: new Date().toISOString()
      });

      const mobileTabListeners = new Set();
      window.__xmatrixMobileTabChange = (view, spaceId) => {
        mobileTabListeners.forEach((listener) => {
          try { listener(spaceId ? { view, spaceId } : { view }); } catch (_) {}
        });
      };

      window.xmatrixDesktop = {
        client: "ios",
        platform: "ios",
        getContext: () => invoke("getContext"),
        setBadge: (count) => invoke("setBadge", { count }),
        setTitle: (title) => invoke("setTitle", { title }),
        getNotificationSettings: () => invoke("getNotificationSettings"),
        requestNotifications: () => invoke("requestNotifications"),
        notify: (payload) => invoke("notify", payload),
        openExternal: (url) => invoke("openExternal", { url }),
        getClipboardImages: () => invoke("getClipboardImages"),
        checkCliInstalled: () => invoke("checkCliInstalled"),
        openCliInstall: () => invoke("openCliInstall"),
        setMobileTabState: (state) => invoke("setMobileTabState", state),
        onMobileTabChange: (listener) => {
          mobileTabListeners.add(listener);
          return () => mobileTabListeners.delete(listener);
        },
        checkForUpdates: () => Promise.resolve(disabledUpdateStatus()),
        getUpdateStatus: () => Promise.resolve(disabledUpdateStatus()),
        installUpdate: () => Promise.resolve(disabledUpdateStatus()),
        showUpdateNotification: (payload) => invoke("notify", payload || {
          title: "xMatrix updates",
          body: "Install updates from the App Store or TestFlight."
        }),
        onUpdateStatus: (listener) => {
          Promise.resolve().then(() => listener(disabledUpdateStatus()));
          return () => {};
        }
      };
    })();
    """

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard AppConfiguration.isTrustedAppPage(message.webView?.url ?? webView?.url) else {
            return
        }

        guard
            let body = message.body as? [String: Any],
            let id = body["id"] as? String,
            let method = body["method"] as? String
        else {
            return
        }

        let payload = body["payload"] as? [String: Any]

        Task { @MainActor in
            do {
                let result = try await handle(method: method, payload: payload)
                resolve(id: id, ok: true, value: result)
            } catch {
                resolve(id: id, ok: false, value: error.localizedDescription)
            }
        }
    }

    @MainActor
    private func handle(method: String, payload: [String: Any]?) async throws -> Any {
        switch method {
        case "getContext":
            return [
                "client": "ios",
                "platform": "ios",
                "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0",
                "isPackaged": true,
                "startUrl": AppConfiguration.startURL.absoluteString
            ]

        case "setBadge":
            let count = max(0, intValue(payload?["count"]))
            try await setBadge(count)
            return NSNull()

        case "setTitle":
            return NSNull()

        case "notify":
            let title = payload?["title"] as? String
            let body = payload?["body"] as? String
            let url = payload?["url"] as? String
            let channelId = payload?["channelId"] as? String
            let silent = boolValue(payload?["silent"])
            return try await notify(title: title, body: body, url: url, channelId: channelId, silent: silent)

        case "getNotificationSettings":
            return await notificationSettings()

        case "requestNotifications":
            return try await requestNotifications()

        case "openExternal":
            guard
                let value = payload?["url"] as? String,
                let url = URL(string: value),
                isSafeExternalURL(url)
            else {
                return NSNull()
            }
            await UIApplication.shared.open(url)
            return NSNull()

        case "getClipboardImages":
            return clipboardImages()

        case "checkCliInstalled":
            return ["installed": false]

        case "openCliInstall":
            await UIApplication.shared.open(AppConfiguration.cliInstallURL)
            return NSNull()

        case "setMobileTabState":
            updateMobileTabState(from: payload)
            return NSNull()

        default:
            throw NSError(
                domain: "sh.xmatrix.app",
                code: 404,
                userInfo: [NSLocalizedDescriptionKey: "Unsupported native bridge method: \(method)"]
            )
        }
    }

    @MainActor
    func updateMobileTabState(from payload: [String: Any]?) {
        let visible = boolValue(payload?["visible"])
        let activeView = payload?["activeView"] as? String ?? "pages"
        let state = MobileTabState(visible: visible, activeView: activeView)
        onMobileTabStateChanged?(state)
    }

    @MainActor
    private func setBadge(_ count: Int) async throws {
        if count > 0 {
            let granted = try await ensureNotificationAuthorization(options: [.badge])
            guard granted else {
                return
            }
        }

        if #available(iOS 16.0, *) {
            do {
                try await UNUserNotificationCenter.current().setBadgeCount(count)
            } catch {
                if count > 0 {
                    throw error
                }
            }
        } else {
            UIApplication.shared.applicationIconBadgeNumber = count
        }
    }

    private func notify(
        title: String?,
        body: String?,
        url: String?,
        channelId: String?,
        silent: Bool
    ) async throws -> Bool {
        let cleanTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !cleanTitle.isEmpty else {
            return false
        }

        let center = UNUserNotificationCenter.current()
        let granted = try await ensureNotificationAuthorization(options: [.alert, .badge, .sound])
        guard granted else {
            return false
        }

        let content = UNMutableNotificationContent()
        content.title = cleanTitle
        content.body = body ?? ""
        if !silent {
            content.sound = .default
        }
        if let url = normalizedNotificationURL(url, channelId: channelId) {
            content.userInfo[Self.notificationURLKey] = url.absoluteString
        }
        if let channelId, !channelId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            content.userInfo[Self.notificationChannelIDKey] = channelId
        }

        let request = UNNotificationRequest(
            identifier: "xmatrix-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        try await center.add(request)
        return true
    }

    private func notificationSettings() async -> [String: Any] {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return [
            "supported": true,
            "permission": authorizationStatusName(settings.authorizationStatus),
            "alert": settings.alertSetting == .enabled,
            "badge": settings.badgeSetting == .enabled,
            "sound": settings.soundSetting == .enabled
        ]
    }

    private func requestNotifications() async throws -> [String: Any] {
        _ = try await ensureNotificationAuthorization(options: [.alert, .badge, .sound])
        return await notificationSettings()
    }

    private func clipboardImages() -> [[String: Any]] {
        let pasteboard = UIPasteboard.general
        let preferredTypes: [(type: String, mimeType: String, fileExtension: String)] = [
            ("public.png", "image/png", "png"),
            ("public.jpeg", "image/jpeg", "jpg"),
            ("com.compuserve.gif", "image/gif", "gif"),
            ("org.webmproject.webp", "image/webp", "webp")
        ]
        var images: [[String: Any]] = []

        for item in pasteboard.items.prefix(4) {
            for preferred in preferredTypes {
                guard let data = item[preferred.type] as? Data else {
                    continue
                }
                images.append(clipboardImagePayload(data: data, mimeType: preferred.mimeType, fileExtension: preferred.fileExtension))
                break
            }
        }

        if images.isEmpty, let image = pasteboard.image, let data = image.pngData() {
            images.append(clipboardImagePayload(data: data, mimeType: "image/png", fileExtension: "png"))
        }

        return images
    }

    private func clipboardImagePayload(data: Data, mimeType: String, fileExtension: String) -> [String: Any] {
        return [
            "name": "pasted-image.\(fileExtension)",
            "mimeType": mimeType,
            "size": data.count,
            "dataUrl": "data:\(mimeType);base64,\(data.base64EncodedString())"
        ]
    }

    private func ensureNotificationAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            return try await center.requestAuthorization(options: options)
        case .denied:
            return false
        @unknown default:
            return false
        }
    }

    private func authorizationStatusName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized:
            return "granted"
        case .denied:
            return "denied"
        case .notDetermined:
            return "not-determined"
        case .provisional:
            return "provisional"
        case .ephemeral:
            return "ephemeral"
        @unknown default:
            return "unsupported"
        }
    }

    private func normalizedNotificationURL(_ value: String?, channelId: String?) -> URL? {
        if let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
            if let absoluteURL = URL(string: value), absoluteURL.scheme != nil {
                if absoluteURL.scheme == AppConfiguration.appScheme || AppConfiguration.isTrustedNavigation(absoluteURL) {
                    return absoluteURL
                }
            }

            if let relativeURL = URL(string: value, relativeTo: AppConfiguration.startURL)?.absoluteURL,
               AppConfiguration.isTrustedNavigation(relativeURL) {
                return relativeURL
            }
        }

        if let channelId = channelId?.trimmingCharacters(in: .whitespacesAndNewlines), !channelId.isEmpty {
            var components = URLComponents()
            components.scheme = AppConfiguration.appScheme
            components.host = "channel"
            components.path = "/\(channelId)"
            return components.url
        }

        return nil
    }

    private func isSafeExternalURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else {
            return false
        }

        return ["http", "https", "mailto"].contains(scheme)
    }

    @MainActor
    private func openNotification(_ userInfo: [AnyHashable: Any]) {
        guard
            let value = userInfo[Self.notificationURLKey] as? String,
            let url = URL(string: value)
        else {
            onOpenURL?(AppConfiguration.startURL)
            return
        }

        if url.scheme == AppConfiguration.appScheme {
            onOpenURL?(AppConfiguration.mapDeepLink(url))
            return
        }

        if AppConfiguration.isTrustedNavigation(url) {
            onOpenURL?(url)
            return
        }

        UIApplication.shared.open(url)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .list, .sound, .badge]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        await MainActor.run {
            openNotification(response.notification.request.content.userInfo)
        }
    }

    @MainActor
    private func resolve(id: String, ok: Bool, value: Any) {
        guard let webView else {
            return
        }

        let json: String
        if JSONSerialization.isValidJSONObject(value) {
            if let data = try? JSONSerialization.data(withJSONObject: value),
               let serialized = String(data: data, encoding: .utf8) {
                json = serialized
            } else {
                json = "null"
            }
        } else if value is NSNull {
            json = "null"
        } else if let string = value as? String {
            json = quote(string)
        } else if let bool = value as? Bool {
            json = bool ? "true" : "false"
        } else {
            json = "null"
        }

        webView.evaluateJavaScript("window.__xmatrixNativeResolve(\(quote(id)), \(ok ? "true" : "false"), \(json));")
    }

    private func intValue(_ value: Any?) -> Int {
        if let value = value as? Int {
            return value
        }
        if let value = value as? Double {
            return Int(value)
        }
        if let value = value as? NSNumber {
            return value.intValue
        }
        if let value = value as? String, let parsed = Int(value) {
            return parsed
        }
        return 0
    }

    private func boolValue(_ value: Any?) -> Bool {
        if let value = value as? Bool {
            return value
        }
        if let value = value as? NSNumber {
            return value.boolValue
        }
        if let value = value as? String {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return normalized == "true" || normalized == "1" || normalized == "yes"
        }
        return false
    }

    private func quote(_ value: String) -> String {
        var escaped = value
        escaped = escaped.replacingOccurrences(of: "\\", with: "\\\\")
        escaped = escaped.replacingOccurrences(of: "\"", with: "\\\"")
        escaped = escaped.replacingOccurrences(of: "\n", with: "\\n")
        escaped = escaped.replacingOccurrences(of: "\r", with: "\\r")
        escaped = escaped.replacingOccurrences(of: "\t", with: "\\t")
        return "\"\(escaped)\""
    }
}
