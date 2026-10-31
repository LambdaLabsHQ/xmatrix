import Network
import Photos
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import UserNotifications
import WebKit

struct WebContainerView: UIViewRepresentable {
    // The Wood theme's light paper, including while a page is loading.
    static let shellBackground = UIColor(red: 249 / 255, green: 247 / 255, blue: 243 / 255, alpha: 1)
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
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private(set) var webView: WKWebView?
        private var bridge: NativeBridge?
        private var pageCoordinator: PageCoordinator?
        /// The dock tab the page last reported showing.
        private(set) var activeTab: MobileTabView = .pages
        var lastHandledDeepLink: URL?
        private weak var containerView: UIView?
        private let webViewFactory: (WKWebViewConfiguration) -> WKWebView
        private let runScript: (WKWebView, String) -> Void
        /// Runs a script that answers true or false.
        private let askScript: (WKWebView, String, @escaping (Bool) -> Void) -> Void
        /// Who draws the left-edge swipe under way, nil when none is.
        private var edgeSwipeDrawer: EdgeSwipeDrawer?
        /// A swipe let go before the page said whether it draws it.
        private var edgeSwipeRelease: (back: Bool, speed: CGFloat)?
        /// How far the finger has come, for a snapshot that starts late.
        private var edgeSwipeDistance: CGFloat = 0
        /// Whether letting go now would go Back; crossing it ticks once.
        private var edgeSwipeArmed = false
        private let edgeSwipeHaptic = UIImpactFeedbackGenerator(style: .soft)
        /// A swipe the page does not draw: the screen being swiped away, and
        /// the paper it uncovers until the page has gone Back under it.
        private var swipeCover: UIView?
        private var swipeBackdrop: UIView?

        func attach(to containerView: UIView) {
            self.containerView = containerView
        }

        init(
            webViewFactory: @escaping (WKWebViewConfiguration) -> WKWebView = {
                WKWebView(frame: .zero, configuration: $0)
            },
            runScript: @escaping (WKWebView, String) -> Void = { webView, script in
                webView.evaluateJavaScript(script)
            },
            askScript: @escaping (WKWebView, String, @escaping (Bool) -> Void) -> Void = { webView, script, answer in
                webView.evaluateJavaScript(script) { result, _ in answer((result as? Bool) == true) }
            }
        ) {
            self.webViewFactory = webViewFactory
            self.runScript = runScript
            self.askScript = askScript
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
            // WebKit's own swipe walked the browser history and showed a
            // snapshot of whatever the page was before; the edge swipe goes
            // Back the way the page does instead, following the finger. It
            // runs alongside the page's own touches and scrolling, which
            // otherwise took the drag first.
            webView.allowsBackForwardNavigationGestures = false
            let edgeSwipe = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgeSwipe(_:)))
            edgeSwipe.edges = .left
            edgeSwipe.delegate = self
            webView.addGestureRecognizer(edgeSwipe)
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
                self?.openDeepLink(url)
            }
            Task { @MainActor [weak bridge] in
                NotificationTaps.shared.deliver { userInfo in
                    bridge?.openNotification(userInfo)
                }
            }
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
            lastRequestedURL = url
            webView.load(URLRequest(url: url))
        }

        // MARK: Load failure

        /// The address the page was last asked to open, retried after a failure.
        private var lastRequestedURL: URL?
        private var loadFailureView: LoadFailureView?
        private var loadRetryTimer: Timer?
        private var networkMonitor: NWPathMonitor?

        /// The app's page did not arrive: say why over the paper, offer a retry,
        /// and try again by itself when the network returns and every 15 s.
        fileprivate func showLoadFailure(_ error: Error, failingURL: URL?) {
            guard let containerView else { return }
            if let failingURL, failingURL.scheme?.hasPrefix("http") == true { lastRequestedURL = failingURL }
            let offline = (error as NSError).code == NSURLErrorNotConnectedToInternet
            let failureView = loadFailureView ?? {
                let view = LoadFailureView { [weak self] in self?.retryLoad() }
                view.translatesAutoresizingMaskIntoConstraints = false
                containerView.addSubview(view)
                NSLayoutConstraint.activate([
                    view.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
                    view.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
                    view.topAnchor.constraint(equalTo: containerView.topAnchor),
                    view.bottomAnchor.constraint(equalTo: containerView.bottomAnchor),
                ])
                loadFailureView = view
                return view
            }()
            failureView.setOffline(offline)
            containerView.bringSubviewToFront(failureView)
            if loadRetryTimer == nil {
                loadRetryTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                    self?.retryLoad()
                }
            }
            if networkMonitor == nil {
                let monitor = NWPathMonitor()
                monitor.pathUpdateHandler = { [weak self] path in
                    guard path.status == .satisfied else { return }
                    DispatchQueue.main.async { self?.retryLoad() }
                }
                monitor.start(queue: .global(qos: .utility))
                networkMonitor = monitor
            }
        }

        fileprivate func hideLoadFailure() {
            loadRetryTimer?.invalidate()
            loadRetryTimer = nil
            networkMonitor?.cancel()
            networkMonitor = nil
            loadFailureView?.removeFromSuperview()
            loadFailureView = nil
        }

        private func retryLoad() {
            guard loadFailureView != nil else { return }
            webView?.load(URLRequest(url: lastRequestedURL ?? AppConfiguration.mobileTabURL(.pages)))
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

        /// A notification or link opens in the running page when it names
        /// something there (a conversation, a page); loading the page afresh
        /// started the whole app again behind its preparation bar.
        func openDeepLink(_ url: URL) {
            guard
                let webView, webView.url != nil,
                let data = try? JSONSerialization.data(withJSONObject: [url.absoluteString]),
                let arguments = String(data: data, encoding: .utf8)
            else {
                load(url)
                return
            }
            askScript(webView, "window.__xmatrixOpenAppLink?.(...\(arguments)) === true") { [weak self] opened in
                if !opened { self?.load(url) }
            }
        }

        /// The left-edge swipe follows the finger. Let go far or fast enough,
        /// it is the page's Back: to the parent screen, or closing the top
        /// layer. Short of that, everything settles back in place.
        @objc func handleEdgeSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
            guard let view = gesture.view else { return }
            let distance = gesture.translation(in: view).x
            switch gesture.state {
            case .began: edgeSwipeBegan()
            case .changed: edgeSwipeMoved(distance: distance)
            case .ended: edgeSwipeEnded(distance: distance, speed: gesture.velocity(in: view).x)
            case .cancelled, .failed: edgeSwipeEnded(distance: 0, speed: 0)
            default: break
            }
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }

        /// How close to the left edge a touch must land to be a swipe's start.
        static let edgeSwipePrepareWidth: CGFloat = 24

        /// A touch at the left edge may become the swipe. The page sets the
        /// swipe up as soon as the finger lands, invisibly, so by the time the
        /// swipe is recognized it starts on a page that is ready; one that never
        /// becomes a swipe is put away by the page.
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            if gestureRecognizer is UIScreenEdgePanGestureRecognizer, let webView,
               touch.location(in: webView).x <= Self.edgeSwipePrepareWidth {
                runScript(webView, "window.__xmatrixBackGesture?.prepare?.()")
            }
            return true
        }

        /// Distance or speed past which letting go goes Back.
        static let edgeSwipeBackDistance: CGFloat = 80
        static let edgeSwipeBackSpeed: CGFloat = 600

        /// A conversation going back to its channel list is drawn by the page:
        /// only the lists move, while the bar, its sign and the tab bar stay
        /// where they are. Any other Back slides a snapshot of the screen away.
        /// The page is asked first; the drag goes to it while it answers, and
        /// it drops the drag if it declines.
        enum EdgeSwipeDrawer { case asking, page, snapshot }

        func edgeSwipeBegan() {
            guard let webView, edgeSwipeDrawer == nil else { return }
            edgeSwipeDrawer = .asking
            edgeSwipeRelease = nil
            edgeSwipeDistance = 0
            edgeSwipeArmed = false
            edgeSwipeHaptic.prepare()
            askScript(webView, "window.__xmatrixBackGesture?.begin() === true") { [weak self] pageDraws in
                self?.edgeSwipeAnswered(pageDraws: pageDraws)
            }
        }

        func edgeSwipeMoved(distance: CGFloat) {
            guard let drawer = edgeSwipeDrawer, let webView else { return }
            let distance = max(0, distance)
            edgeSwipeDistance = distance
            let armed = distance > Self.edgeSwipeBackDistance
            if armed && !edgeSwipeArmed {
                edgeSwipeHaptic.impactOccurred(intensity: 0.7)
                edgeSwipeHaptic.prepare()
            }
            edgeSwipeArmed = armed
            switch drawer {
            case .asking, .page:
                runScript(webView, "window.__xmatrixBackGesture?.move(\(Double(distance)))")
                if drawer == .page { postBackSwipe(["progress": distance / max(webView.bounds.width, 1)]) }
            case .snapshot:
                swipeCover?.transform = CGAffineTransform(translationX: distance, y: 0)
            }
        }

        func edgeSwipeEnded(distance: CGFloat, speed: CGFloat) {
            guard let drawer = edgeSwipeDrawer else { return }
            let back = distance > Self.edgeSwipeBackDistance || speed > Self.edgeSwipeBackSpeed
            switch drawer {
            case .asking: edgeSwipeRelease = (back, speed)
            case .page: releasePageSwipe(back: back, speed: speed)
            case .snapshot: releaseSnapshotSwipe(back: back)
            }
        }

        private func edgeSwipeAnswered(pageDraws: Bool) {
            guard edgeSwipeDrawer == .asking else { return }
            edgeSwipeDrawer = pageDraws ? .page : .snapshot
            if pageDraws, let webView {
                stopScrolling(in: webView)
            } else {
                coverWithSnapshot()
                swipeCover?.transform = CGAffineTransform(translationX: edgeSwipeDistance, y: 0)
            }
            guard let release = edgeSwipeRelease else { return }
            edgeSwipeRelease = nil
            if pageDraws {
                releasePageSwipe(back: release.back, speed: release.speed)
            } else {
                releaseSnapshotSwipe(back: release.back)
            }
        }

        /// The swipe runs alongside the page's scrolling, which a snapshot used
        /// to hide. With the page drawing it, a list that set off scrolling
        /// under the same finger stops, so it does not ride up while it slides.
        private func stopScrolling(in view: UIView) {
            for subview in view.subviews {
                if let scrollView = subview as? UIScrollView, scrollView.panGestureRecognizer.isEnabled {
                    scrollView.panGestureRecognizer.isEnabled = false
                    scrollView.panGestureRecognizer.isEnabled = true
                }
                stopScrolling(in: subview)
            }
        }

        /// The page settles the lists from the finger's speed and goes Back
        /// itself once they land; the tab bar comes in, or leaves, alongside.
        private func releasePageSwipe(back: Bool, speed: CGFloat) {
            edgeSwipeDrawer = nil
            guard let webView else { return }
            runScript(webView, "window.__xmatrixBackGesture?.end(\(back), \(Double(speed)))")
            postBackSwipe(["settle": back])
        }

        /// The tab bar is the page's dock: it fades in with the list it belongs to.
        private func postBackSwipe(_ info: [String: Any]) {
            NotificationCenter.default.post(name: .xmatrixBackSwipeFollow, object: nil, userInfo: info)
        }

        private func coverWithSnapshot() {
            guard swipeCover == nil, let webView, let containerView,
                  let cover = webView.snapshotView(afterScreenUpdates: false) else { return }
            cover.frame = webView.frame
            let backdrop = UIView(frame: webView.frame)
            backdrop.backgroundColor = WebContainerView.shellBackground
            containerView.insertSubview(backdrop, aboveSubview: webView)
            containerView.insertSubview(cover, aboveSubview: backdrop)
            swipeBackdrop = backdrop
            swipeCover = cover
        }

        private func releaseSnapshotSwipe(back: Bool) {
            edgeSwipeDrawer = nil
            guard back, let webView else {
                settleSnapshot(wentBack: false)
                return
            }
            askScript(webView, "window.__xmatrixNativeBack?.() === true") { [weak self] wentBack in
                self?.settleSnapshot(wentBack: wentBack)
            }
        }

        /// The page has gone Back under the swiped screen, which slides off to
        /// show it; with nothing to go Back to, the screen returns.
        private func settleSnapshot(wentBack: Bool) {
            guard let cover = swipeCover else { return }
            let backdrop = swipeBackdrop
            swipeCover = nil
            swipeBackdrop = nil
            if wentBack { backdrop?.removeFromSuperview() }
            let width = cover.bounds.width
            UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
                cover.transform = wentBack ? CGAffineTransform(translationX: width, y: 0) : .identity
            } completion: { _ in
                cover.removeFromSuperview()
                backdrop?.removeFromSuperview()
            }
        }

        fileprivate func navigationFinished() {
            publishTabBarHeight()
            publishDisplayRadius()
        }
    }

    final class PageCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, UIScrollViewDelegate {
        weak var owner: Coordinator?
        /// Where each in-flight download is being written, keyed by download.
        private var downloadFiles: [ObjectIdentifier: URL] = [:]

        init(owner: Coordinator) {
            self.owner = owner
        }

        // A navigation replaces the document, and with it the inline style the
        // bar height was written to. Layout will not necessarily run again, so
        // replay it rather than wait for the next bar measurement.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            owner?.hideLoadFailure()
            owner?.navigationFinished()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            reportLoadFailure(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            reportLoadFailure(error)
        }

        /// iOS reclaimed the page's process: open it again rather than leave blank paper.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        private func reportLoadFailure(_ error: Error) {
            let nsError = error as NSError
            // A navigation the app replaced, or a link handed to another app, is not a failure.
            guard nsError.domain == NSURLErrorDomain, nsError.code != NSURLErrorCancelled else { return }
            owner?.showLoadFailure(error, failingURL: nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            // An attachment's Download control is an `<a download>`, usually
            // over a blob: URL. Handing that to the system opened nothing.
            if navigationAction.shouldPerformDownload {
                return .download
            }

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

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse
        ) async -> WKNavigationResponsePolicy {
            Self.isAttachmentResponse(navigationResponse.response, canShow: navigationResponse.canShowMIMEType)
                ? .download
                : .allow
        }

        static func isAttachmentResponse(_ response: URLResponse, canShow: Bool) -> Bool {
            let disposition = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
            return !canShow || disposition.lowercased().hasPrefix("attachment")
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(
            _ download: WKDownload,
            decideDestinationUsing response: URLResponse,
            suggestedFilename: String
        ) async -> URL? {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("downloads", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            } catch {
                return nil
            }
            let name = (suggestedFilename as NSString).lastPathComponent
            let file = directory.appendingPathComponent(name.isEmpty ? "attachment" : name)
            downloadFiles[ObjectIdentifier(download)] = file
            return file
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) else { return }
            let webView = download.webView
            Task { @MainActor [weak self] in
                await self?.deliver(file, from: webView)
            }
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            if let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) {
                try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            }
            Self.present(Self.alert(title: "Download failed", message: error.localizedDescription), from: download.webView)
        }

        enum DownloadDestination: Equatable {
            case photos(PHAssetResourceType)
            case files
        }

        /// Videos and images go straight to Photos, which is where an iPhone
        /// keeps them; anything else, including video Photos cannot hold such
        /// as WebM, is exported to Files.
        static func destination(for file: URL) -> DownloadDestination {
            guard let type = UTType(filenameExtension: file.pathExtension) else { return .files }
            if type.conforms(to: .mpeg4Movie) || type.conforms(to: .quickTimeMovie) {
                return .photos(.video)
            }
            if type.conforms(to: .image) {
                return .photos(.photo)
            }
            return .files
        }

        @MainActor
        private func deliver(_ file: URL, from webView: WKWebView?) async {
            switch Self.destination(for: file) {
            case .files:
                let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
                Self.present(picker, from: webView)
            case let .photos(resource):
                defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
                let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
                guard status == .authorized || status == .limited else {
                    Self.present(
                        Self.alert(
                            title: "Allow xMatrix to add to Photos",
                            message: "Turn on Photos access for xMatrix in Settings to save attachments."
                        ),
                        from: webView
                    )
                    return
                }
                do {
                    try await PHPhotoLibrary.shared().performChanges {
                        PHAssetCreationRequest.forAsset().addResource(with: resource, fileURL: file, options: nil)
                    }
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    Self.present(
                        Self.alert(title: resource == .video ? "Video saved to Photos" : "Image saved to Photos", message: nil),
                        from: webView
                    )
                } catch {
                    Self.present(Self.alert(title: "Could not save to Photos", message: error.localizedDescription), from: webView)
                }
            }
        }

        private static func alert(title: String, message: String?) -> UIAlertController {
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            return alert
        }

        private static func present(_ controller: UIViewController, from webView: WKWebView?) {
            guard var presenter = webView?.window?.rootViewController else { return }
            while let presented = presenter.presentedViewController {
                presenter = presented
            }
            presenter.present(controller, animated: true)
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            nil
        }
    }
}

/// What the window shows when the app's page could not load: one tile of the
/// app's tinted paper saying why, with a retry in place. No shadow, no glass.
final class LoadFailureView: UIView {
    private let message = UILabel()
    private let onRetry: () -> Void

    init(onRetry: @escaping () -> Void) {
        self.onRetry = onRetry
        super.init(frame: .zero)
        backgroundColor = WebContainerView.shellBackground
        let ink = UIColor(red: 40 / 255, green: 32 / 255, blue: 24 / 255, alpha: 1)

        let tile = UIStackView()
        tile.axis = .vertical
        tile.alignment = .center
        tile.spacing = 10
        tile.isLayoutMarginsRelativeArrangement = true
        tile.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 18)
        tile.backgroundColor = ink.withAlphaComponent(0.05)
        tile.layer.cornerRadius = 10
        tile.translatesAutoresizingMaskIntoConstraints = false

        message.font = .systemFont(ofSize: 15, weight: .semibold)
        message.textColor = ink.withAlphaComponent(0.72)
        message.numberOfLines = 0
        message.textAlignment = .center

        var retry = UIButton.Configuration.plain()
        retry.title = "Try again"
        retry.baseForegroundColor = ink.withAlphaComponent(0.95)
        retry.background.backgroundColor = ink.withAlphaComponent(0.06)
        retry.background.cornerRadius = 8
        retry.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14)
        let button = UIButton(configuration: retry, primaryAction: UIAction { [weak self] _ in self?.onRetry() })

        tile.addArrangedSubview(message)
        tile.addArrangedSubview(button)
        addSubview(tile)
        NSLayoutConstraint.activate([
            tile.centerXAnchor.constraint(equalTo: centerXAnchor),
            tile.centerYAnchor.constraint(equalTo: centerYAnchor),
            tile.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            tile.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
        ])
        setOffline(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func setOffline(_ offline: Bool) {
        message.text = offline
            ? "You’re offline. xMatrix will open when the network is back."
            : "xMatrix can’t be reached right now. Still trying to connect…"
    }
}
