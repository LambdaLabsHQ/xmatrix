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
        /// While the left edge is dragged: the screen being swiped away, and
        /// the paper it uncovers until the page has gone Back under it.
        private var swipeCover: UIView?
        private var swipeBackdrop: UIView?
        /// The warm shade over whatever lies under the swiped screen.
        private var swipeShade: UIView?
        /// Whether letting go now would go Back; crossing it ticks once.
        private var swipeArmed = false
        private var swipeHaptic: UIImpactFeedbackGenerator?
        private var swipeAnimator: UIViewPropertyAnimator?

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

        /// The left-edge swipe moves the screen with the finger. Let go far or
        /// fast enough, it is the page's Back: to the parent screen, or closing
        /// the top layer. Short of that, the screen settles back in place.
        @objc func handleEdgeSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
            guard let view = gesture.view else { return }
            let distance = gesture.translation(in: view).x
            switch gesture.state {
            case .began: edgeSwipeBegan()
            case .changed: edgeSwipeMoved(distance: distance)
            case .ended: edgeSwipeEnded(distance: distance, speed: gesture.velocity(in: view).x)
            case .cancelled, .failed: settleEdgeSwipe(wentBack: false)
            default: break
            }
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }

        /// Distance or speed past which letting go goes Back.
        static let edgeSwipeBackDistance: CGFloat = 80
        static let edgeSwipeBackSpeed: CGFloat = 600

        /// The swiped screen lifts off the paper like a plank: it takes the
        /// device's corners, settles back a little in depth and turns on its
        /// far edge, with a shadow that lengthens as it travels. Under it, a
        /// warm shade lifts as more of the paper shows.
        func edgeSwipeBegan() {
            // A new drag lands the last swipe where it was heading first.
            if let animator = swipeAnimator, animator.state == .active {
                animator.stopAnimation(false)
                animator.finishAnimation(at: .end)
            }
            guard swipeCover == nil, let webView, let containerView,
                  let snapshot = webView.snapshotView(afterScreenUpdates: false) else { return }
            let radius = DisplayCorner.radius > 0 ? DisplayCorner.radius : 44
            let cover = UIView(frame: webView.frame)
            cover.layer.shadowColor = UIColor(red: 40 / 255, green: 32 / 255, blue: 24 / 255, alpha: 1).cgColor
            cover.layer.shadowOpacity = 0
            cover.layer.shadowRadius = 24
            cover.layer.shadowOffset = CGSize(width: -6, height: 0)
            cover.layer.shadowPath = UIBezierPath(roundedRect: cover.bounds, cornerRadius: radius).cgPath
            snapshot.frame = cover.bounds
            snapshot.layer.cornerRadius = radius
            snapshot.layer.cornerCurve = .continuous
            snapshot.layer.masksToBounds = true
            snapshot.layer.borderWidth = 0.5
            snapshot.layer.borderColor = UIColor(red: 120 / 255, green: 88 / 255, blue: 56 / 255, alpha: 0.18).cgColor
            cover.addSubview(snapshot)
            let backdrop = UIView(frame: webView.frame)
            backdrop.backgroundColor = WebContainerView.shellBackground
            let shade = UIView(frame: webView.frame)
            shade.backgroundColor = UIColor(red: 40 / 255, green: 32 / 255, blue: 24 / 255, alpha: 1)
            shade.isUserInteractionEnabled = false
            containerView.insertSubview(backdrop, aboveSubview: webView)
            containerView.insertSubview(shade, aboveSubview: backdrop)
            containerView.insertSubview(cover, aboveSubview: shade)
            swipeBackdrop = backdrop
            swipeShade = shade
            swipeCover = cover
            swipeArmed = false
            swipeHaptic = UIImpactFeedbackGenerator(style: .soft)
            swipeHaptic?.prepare()
            layOutEdgeSwipe(distance: 0)
        }

        func edgeSwipeMoved(distance: CGFloat) {
            layOutEdgeSwipe(distance: distance)
            let armed = distance > Self.edgeSwipeBackDistance
            if armed && !swipeArmed {
                swipeHaptic?.impactOccurred(intensity: 0.7)
                swipeHaptic?.prepare()
            }
            swipeArmed = armed
        }

        /// One pose of the swipe: the cover `distance` points along, the shade
        /// matching. Past the screen's width the plank keeps turning away.
        private func layOutEdgeSwipe(distance: CGFloat) {
            guard let cover = swipeCover else { return }
            let width = max(cover.bounds.width, 1)
            let progress = min(max(distance / width, 0), 1.2)
            cover.transform3D = Self.plankTransform(distance: max(0, distance), progress: progress)
            cover.layer.shadowOpacity = Float(min(progress * 3, 1) * 0.28)
            swipeShade?.alpha = 0.16 * (1 - min(progress, 1))
        }

        /// The swiped screen's pose: along the finger, a little smaller, and
        /// turned on its vertical axis so the far edge recedes. Reduce Motion
        /// keeps only the slide.
        static func plankTransform(distance: CGFloat, progress: CGFloat) -> CATransform3D {
            var transform = CATransform3DIdentity
            transform.m34 = -1 / 1400
            transform = CATransform3DTranslate(transform, distance, 0, 0)
            guard !UIAccessibility.isReduceMotionEnabled else { return transform }
            let scale = 1 - 0.07 * min(progress * 1.6, 1)
            transform = CATransform3DScale(transform, scale, scale, 1)
            return CATransform3DRotate(transform, 0.14 * progress, 0, 1, 0)
        }

        func edgeSwipeEnded(distance: CGFloat, speed: CGFloat) {
            guard let webView, distance > Self.edgeSwipeBackDistance || speed > Self.edgeSwipeBackSpeed else {
                settleEdgeSwipe(wentBack: false, speed: speed)
                return
            }
            askScript(webView, "window.__xmatrixNativeBack?.() === true") { [weak self] wentBack in
                self?.settleEdgeSwipe(wentBack: wentBack, speed: speed)
            }
        }

        /// The page has gone Back under the swiped screen, which flies off on
        /// a spring carrying the finger's speed while the parent slides in
        /// from behind it and comes out of the shade. With nothing to go Back
        /// to, the screen springs back into place.
        private func settleEdgeSwipe(wentBack: Bool, speed: CGFloat = 0) {
            guard let cover = swipeCover else { return }
            let backdrop = swipeBackdrop
            let shade = swipeShade
            swipeCover = nil
            swipeBackdrop = nil
            swipeShade = nil
            swipeHaptic = nil
            swipeArmed = false
            let width = max(cover.bounds.width, 1)
            let from = cover.layer.presentation()?.transform.m41 ?? cover.transform3D.m41
            let to: CGFloat = wentBack ? width * 1.08 : 0
            let remaining = to - from
            let velocity = abs(remaining) > 1 ? max(min(speed / remaining, 30), -30) : 0
            let spring = UISpringTimingParameters(
                dampingRatio: wentBack ? 1 : 0.82,
                initialVelocity: CGVector(dx: velocity, dy: 0)
            )
            let animator = UIViewPropertyAnimator(duration: wentBack ? 0.42 : 0.5, timingParameters: spring)
            let reveal = wentBack && !UIAccessibility.isReduceMotionEnabled ? webView : nil
            if wentBack {
                backdrop?.removeFromSuperview()
                // The parent waits a third of a screen behind, as UIKit's own
                // pop does, and catches up as the plank leaves.
                let lag = (width - from) * 0.3
                reveal?.transform = CGAffineTransform(translationX: -lag, y: 0)
            }
            animator.addAnimations {
                cover.transform3D = Self.plankTransform(distance: to, progress: to / width)
                shade?.alpha = wentBack ? 0 : 0.16
                reveal?.transform = .identity
            }
            let shadow = CABasicAnimation(keyPath: "shadowOpacity")
            shadow.fromValue = cover.layer.presentation()?.shadowOpacity ?? cover.layer.shadowOpacity
            shadow.toValue = 0
            shadow.duration = wentBack ? 0.42 : 0.35
            cover.layer.shadowOpacity = 0
            cover.layer.add(shadow, forKey: "shadowOpacity")
            animator.addCompletion { [weak self] _ in
                reveal?.transform = .identity
                cover.removeFromSuperview()
                shade?.removeFromSuperview()
                backdrop?.removeFromSuperview()
                if self?.swipeAnimator === animator { self?.swipeAnimator = nil }
            }
            swipeAnimator = animator
            animator.startAnimation()
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
