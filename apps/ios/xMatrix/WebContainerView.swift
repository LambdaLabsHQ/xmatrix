import SwiftUI
import UIKit
import UserNotifications
import WebKit

struct WebContainerView: UIViewRepresentable {
    // The Wood theme's light paper, including while a page is loading.
    static let shellBackground = UIColor(red: 245 / 255, green: 239 / 255, blue: 229 / 255, alpha: 1)
    @ObservedObject var router: AppRouter

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIView {
        let containerView = UIView()
        containerView.backgroundColor = Self.shellBackground

        context.coordinator.attach(to: containerView)
        if let url = router.pendingDeepLink {
            context.coordinator.lastHandledDeepLink = url
            context.coordinator.openDeepLink(AppConfiguration.mapDeepLink(url))
        } else {
            // With nothing to open, the app starts on how the Space stands.
            context.coordinator.load(AppConfiguration.mobileTabURL(.pages))
        }
        return containerView
    }

    func updateUIView(_ containerView: UIView, context: Context) {
        guard let url = router.pendingDeepLink, context.coordinator.lastHandledDeepLink != url else {
            return
        }

        context.coordinator.lastHandledDeepLink = url
        context.coordinator.openDeepLink(AppConfiguration.mapDeepLink(url))
    }

    /// One page for the whole app. The native tab bar only tells it which dock
    /// tab to show, and the web layer keeps one mounted pane per tab, so
    /// switching tabs never boots, reloads or rebuilds anything. A page per tab
    /// used to start the whole app again on each first visit, and iOS suspends
    /// or reclaims a hidden page, which reloaded it on the way back.
    final class Coordinator: NSObject {
        private(set) var webView: WKWebView?
        private var bridge: NativeBridge?
        private var pageCoordinator: PageCoordinator?
        /// The dock tab the page last reported showing.
        private(set) var activeTab: MobileTabView = .pages
        var lastHandledDeepLink: URL?
        private weak var containerView: UIView?
        private let webViewFactory: (WKWebViewConfiguration) -> WKWebView
        private let runScript: (WKWebView, String) -> Void

        func attach(to containerView: UIView) {
            self.containerView = containerView
        }

        init(
            webViewFactory: @escaping (WKWebViewConfiguration) -> WKWebView = {
                WKWebView(frame: .zero, configuration: $0)
            },
            runScript: @escaping (WKWebView, String) -> Void = { webView, script in
                webView.evaluateJavaScript(script)
            }
        ) {
            self.webViewFactory = webViewFactory
            self.runScript = runScript
            super.init()
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleMobileTabSelected(_:)),
                name: .xmatrixMobileTabSelected,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleTabBarHeightChanged),
                name: .xmatrixMobileTabBarHeightChanged,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleDisplayCornerRadiusChanged),
                name: .xmatrixDisplayCornerRadiusChanged,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleWillEnterForeground),
                name: UIApplication.willEnterForegroundNotification,
                object: nil
            )
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        @objc private func handleMobileTabSelected(_ notification: Notification) {
            guard
                let view = notification.userInfo?["view"] as? String,
                let tab = MobileTabView(rawValue: view)
            else {
                return
            }
            select(tab)
        }

        /// iOS suspends the page in the background, and it resumes with its
        /// sockets still OPEN but dead; no web event says so reliably. Tell the
        /// page it resumed so it replaces them at once.
        @objc func handleWillEnterForeground() {
            guard let webView else { return }
            runScript(webView, "window.dispatchEvent(new Event('xmatrix:native-resume'));")
        }

        @objc private func handleTabBarHeightChanged() {
            publishTabBarHeight()
        }

        @objc private func handleDisplayCornerRadiusChanged() {
            publishDisplayRadius()
        }

        /// The web layer reserves --app-native-tab-bar-height at the bottom of
        /// every mobile surface, and takes --app-native-dock-inset as the edge
        /// every floating surface shares: the top plank, the lists under it and
        /// the create button line up with the capsule. It is read from
        /// `DockBand`, so a container or page that starts after the dock's
        /// report still gets it, and is replayed after every navigation.
        private func publishTabBarHeight() {
            guard DockBand.height > 0, let webView else { return }
            runScript(webView, """
            document.documentElement.style.setProperty('--app-native-tab-bar-height', '\(DockBand.height)px');
            document.documentElement.style.setProperty('--app-native-dock-inset', '\(DockBand.inset)px');
            """)
        }

        /// --app-native-display-radius lets the channel composer sit concentric
        /// with the device corners, as the dock does. Unset, the web side
        /// falls back to a common radius.
        private func publishDisplayRadius() {
            let radius = DisplayCorner.radius
            guard radius > 0, let webView else { return }
            runScript(webView, "document.documentElement.style.setProperty('--app-native-display-radius', '\(radius)px');")
        }

        private func makeWebView() -> WKWebView {
            let userContentController = WKUserContentController()
            let bridge = NativeBridge()
            userContentController.add(bridge, name: "xmatrixNative")
            userContentController.addUserScript(
                WKUserScript(
                    source: NativeBridge.injectionScript,
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                )
            )

            let configuration = WKWebViewConfiguration()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = true
            configuration.userContentController = userContentController
            configuration.websiteDataStore = .default()

            let webView = webViewFactory(configuration)
            webView.allowsBackForwardNavigationGestures = true
            let pageCoordinator = PageCoordinator(owner: self)
            webView.navigationDelegate = pageCoordinator
            webView.uiDelegate = pageCoordinator
            webView.scrollView.delegate = pageCoordinator
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            webView.scrollView.bounces = false
            webView.scrollView.alwaysBounceVertical = false
            webView.scrollView.alwaysBounceHorizontal = false
            webView.scrollView.minimumZoomScale = 1
            webView.scrollView.maximumZoomScale = 1
            webView.backgroundColor = WebContainerView.shellBackground
            webView.scrollView.backgroundColor = WebContainerView.shellBackground
            webView.isOpaque = false

            bridge.webView = webView
            bridge.onMobileTabStateChanged = { [weak self] state in
                self?.update(state)
            }
            bridge.onOpenURL = { [weak self] url in
                self?.load(url)
            }
            UNUserNotificationCenter.current().delegate = bridge
            self.bridge = bridge
            self.pageCoordinator = pageCoordinator

            return webView
        }

        /// Opens `url` in the page, creating the page the first time.
        func load(_ url: URL) {
            guard let containerView else { return }
            let webView: WKWebView
            if let existing = self.webView {
                webView = existing
            } else {
                webView = makeWebView()
                self.webView = webView
                webView.translatesAutoresizingMaskIntoConstraints = false
                containerView.addSubview(webView)
                NSLayoutConstraint.activate([
                    webView.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
                    webView.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
                    webView.topAnchor.constraint(equalTo: containerView.topAnchor),
                    webView.bottomAnchor.constraint(equalTo: containerView.bottomAnchor),
                ])
            }
            webView.load(URLRequest(url: url))
        }

        /// A tab tap switches the page's own dock pane; nothing loads.
        func select(_ tab: MobileTabView) {
            guard let webView else {
                load(AppConfiguration.mobileTabURL(tab))
                return
            }
            guard
                let data = try? JSONSerialization.data(withJSONObject: [tab.rawValue]),
                let arguments = String(data: data, encoding: .utf8)
            else { return }
            runScript(webView, "window.__xmatrixMobileTabChange?.(...\(arguments));")
        }

        func update(_ state: MobileTabState) {
            activeTab = MobileTabView.tab(for: state.activeView)
            NotificationCenter.default.post(name: .xmatrixMobileTabStateChanged, object: state)
        }

        func openDeepLink(_ url: URL) {
            load(url)
        }

        fileprivate func navigationFinished() {
            publishTabBarHeight()
            publishDisplayRadius()
        }
    }

    final class PageCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, UIScrollViewDelegate {
        weak var owner: Coordinator?

        init(owner: Coordinator) {
            self.owner = owner
        }

        // A navigation replaces the document, and with it the inline style the
        // bar height was written to. Layout will not necessarily run again, so
        // replay it rather than wait for the next bar measurement.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            owner?.navigationFinished()
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else {
                return .allow
            }

            if url.scheme == AppConfiguration.appScheme {
                owner?.openDeepLink(AppConfiguration.mapDeepLink(url))
                return .cancel
            }

            if AppConfiguration.isTrustedNavigation(url) {
                return .allow
            }

            await UIApplication.shared.open(url)
            return .cancel
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            guard let url = navigationAction.request.url else {
                return nil
            }

            if AppConfiguration.isTrustedNavigation(url) {
                webView.load(URLRequest(url: url))
            } else {
                UIApplication.shared.open(url)
            }

            return nil
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            nil
        }
    }
}
