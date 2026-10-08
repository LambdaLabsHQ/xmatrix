import XCTest
import WebKit
@testable import xMatrix

@MainActor
final class WebContainerTests: XCTestCase {
    final class RecordingWebView: WKWebView {
        var requests: [URLRequest] = []
        override func load(_ request: URLRequest) -> WKNavigation? {
            requests.append(request)
            return nil
        }
    }

    private func makeCoordinator(
        runScript: @escaping (WKWebView, String) -> Void = { _, _ in }
    ) -> (WebContainerView.Coordinator, UIView) {
        let coordinator = WebContainerView.Coordinator(
            webViewFactory: { RecordingWebView(frame: .zero, configuration: $0) },
            runScript: runScript
        )
        let container = UIView()
        coordinator.attach(to: container)
        return (coordinator, container)
    }

    private func page(_ coordinator: WebContainerView.Coordinator) -> RecordingWebView {
        coordinator.webView as! RecordingWebView
    }

    func testStartupLoadsOnePage() {
        let (coordinator, container) = makeCoordinator()
        coordinator.load(AppConfiguration.mobileTabURL(.pages))
        XCTAssertEqual(container.subviews.count, 1)
        XCTAssertEqual(page(coordinator).backgroundColor, WebContainerView.shellBackground)
        XCTAssertEqual(page(coordinator).scrollView.backgroundColor, WebContainerView.shellBackground)
        XCTAssertEqual(page(coordinator).requests.map(\.url), [AppConfiguration.mobileTabURL(.pages)])
    }

    func testTabTapSwitchesThePagesPaneWithoutLoading() {
        var scripts: [String] = []
        let (coordinator, container) = makeCoordinator { scripts.append($1) }
        coordinator.load(AppConfiguration.mobileTabURL(.pages))
        let first = page(coordinator)
        for tab in [MobileTabView.messages, .status, .more, .pages] {
            NotificationCenter.default.post(name: .xmatrixMobileTabSelected, object: nil,
                                            userInfo: ["view": tab.rawValue])
        }
        XCTAssertTrue(coordinator.webView === first)
        XCTAssertEqual(container.subviews.count, 1)
        XCTAssertEqual(first.requests.count, 1)
        XCTAssertEqual(scripts, ["messages", "status", "more", "pages"].map {
            "window.__xmatrixMobileTabChange?.(...[\"\($0)\"]);"
        })
    }

    func testForegroundTellsThePageItResumed() {
        var scripts: [(WKWebView, String)] = []
        let (coordinator, container) = makeCoordinator { scripts.append(($0, $1)) }
        coordinator.load(AppConfiguration.mobileTabURL(.pages))
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertEqual(container.subviews.count, 1)
        XCTAssertTrue(scripts.contains {
            $0.0 === coordinator.webView && $0.1 == "window.dispatchEvent(new Event('xmatrix:native-resume'));"
        })
    }

    func testDisplayRadiusReachesThePageWithoutADockReport() {
        var scripts: [String] = []
        let (coordinator, container) = makeCoordinator { scripts.append($1) }
        coordinator.load(AppConfiguration.mobileTabURL(.messages))
        XCTAssertEqual(container.subviews.count, 1)
        defer { DisplayCorner.radius = 0 }
        DisplayCorner.radius = 62
        NotificationCenter.default.post(name: .xmatrixDisplayCornerRadiusChanged, object: nil)
        XCTAssertEqual(scripts, [
            "document.documentElement.style.setProperty('--app-native-display-radius', '62.0px');",
        ])
    }

    func testADockReportedBeforeTheContainerStartedStillReachesThePage() {
        defer {
            DockBand.height = 0
            DockBand.inset = 0
        }
        DockBand.height = 62
        DockBand.inset = 21
        var scripts: [String] = []
        let (coordinator, container) = makeCoordinator { scripts.append($1) }
        defer { withExtendedLifetime(container) {} }
        coordinator.load(AppConfiguration.mobileTabURL(.messages))
        let webView = coordinator.webView!
        webView.navigationDelegate?.webView?(webView, didFinish: nil)
        XCTAssertTrue(scripts.contains("""
        document.documentElement.style.setProperty('--app-native-tab-bar-height', '62.0px');
        document.documentElement.style.setProperty('--app-native-dock-inset', '21.0px');
        """))
    }

    func testDeepLinksLoadInTheSamePage() {
        let (coordinator, container) = makeCoordinator()
        let agents = URL(string: "https://xmatrix.sh/app?view=agents")!
        coordinator.openDeepLink(agents)
        let first = page(coordinator)
        let channel = AppConfiguration.mapDeepLink(URL(string: "xmatrix://channel/test-channel")!)
        coordinator.openDeepLink(channel)
        XCTAssertTrue(coordinator.webView === first)
        XCTAssertEqual(container.subviews.count, 1)
        XCTAssertEqual(first.requests.map(\.url), [agents, channel])
    }

    func testReportedViewPicksTheActiveTab() {
        let (coordinator, container) = makeCoordinator()
        defer { withExtendedLifetime(container) {} }
        for (view, tab) in [("pages", MobileTabView.pages), ("messages", .messages), ("status", .status),
                            ("agents", .more), ("roles", .more), ("machines", .more), ("security", .more)] {
            coordinator.update(MobileTabState(visible: true, activeView: view))
            XCTAssertEqual(coordinator.activeTab, tab, view)
        }
    }

    func testBridgeReportsVisibilityAndView() {
        let bridge = NativeBridge()
        var received = MobileTabState()
        bridge.onMobileTabStateChanged = { received = $0 }
        bridge.updateMobileTabState(from: ["visible": true, "activeView": "agents", "userId": "alice", "statusLive": true])
        XCTAssertTrue(received.visible)
        XCTAssertEqual(received.activeView, "agents")
        XCTAssertTrue(received.statusLive)
        bridge.updateMobileTabState(from: [:])
        XCTAssertFalse(received.visible)
        XCTAssertEqual(received.activeView, "pages")
        XCTAssertFalse(received.statusLive)
    }

    func testStatusTabNamesTheCanonicalWebView() {
        XCTAssertEqual(MobileTabView.status.rawValue, "status")
        XCTAssertEqual(MobileTabView.status.label, "Status")
        XCTAssertEqual(AppConfiguration.mobileTabURL(.status).query?.contains("view=status"), true)
        XCTAssertNotNil(UIImage(systemName: MobileTabView.status.icon))
    }

    func testDockMarginIsConcentricWithTheDeviceCorner() {
        // 55pt display corner, 27pt capsule (a 54pt bar): the curves share a center 28pt apart.
        XCTAssertEqual(DockGeometry.concentricMargin(deviceCornerRadius: 55, capsuleRadius: 27), 28)
    }

    func testDockMarginFloorsWhenTheCapsuleIsRounderThanTheDevice() {
        XCTAssertEqual(DockGeometry.concentricMargin(deviceCornerRadius: 18, capsuleRadius: 27), DockGeometry.minimumMargin)
        XCTAssertEqual(DockGeometry.fittedMargin(proposed: 80, boundsWidth: 300), 30)
    }

    func testVisibleDockRecentersAfterALatePlatterShift() throws {
        let controller = NativeMobileTabBarController()
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        controller.apply(MobileTabState(visible: true))
        func settle() {
            for _ in 0..<8 {
                controller.view.setNeedsLayout()
                controller.view.layoutIfNeeded()
            }
        }
        settle()
        let bar = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UITabBar }.first)
        let dock = dockCapsule(in: bar)
        XCTAssertGreaterThan(dock.bounds.height, 1)
        // Simulate UIKit changing the platter offset after initial placement.
        // The center must recover on later layouts, including without a
        // window's resolved device corner radius.
        dock.transform = dock.transform.translatedBy(x: -18, y: 0)
        settle()
        let frame = dock.convert(dock.bounds, to: controller.view)
        XCTAssertEqual(frame.midX, controller.view.bounds.midX, accuracy: 0.5)
    }

    func testDockEndsAreHalfCircles() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = NativeMobileTabBarController()
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        controller.apply(MobileTabState(visible: true))
        for _ in 0..<8 {
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
        }
        guard DisplayCorner.radius > 1 else {
            throw XCTSkip("This simulator reports square display corners.")
        }
        let bar = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UITabBar }.first)
        let dock = dockCapsule(in: bar)
        XCTAssertEqual(dock.effectiveRadius(corner: .bottomLeft), dock.bounds.height / 2, accuracy: 0.5)
    }

    func testStatusPulseRunsOnlyWhileAnAgentWorks() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = NativeMobileTabBarController()
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        func settle(_ state: MobileTabState) {
            controller.apply(state)
            for _ in 0..<8 {
                controller.view.setNeedsLayout()
                controller.view.layoutIfNeeded()
            }
        }
        func pulsing() -> Int {
            var count = 0
            func walk(_ view: UIView) {
                if view is UIImageView, view.layer.mask?.name == "xmatrix.statusPulse" { count += 1 }
                view.subviews.forEach(walk)
            }
            walk(controller.view)
            return count
        }
        settle(MobileTabState(visible: true, activeView: "pages", statusLive: true))
        XCTAssertGreaterThan(pulsing(), 0)
        settle(MobileTabState(visible: true, activeView: "pages", statusLive: false))
        XCTAssertEqual(pulsing(), 0)
    }

    /// The visible capsule: the widest system platter, or the bar itself.
    private func dockCapsule(in bar: UITabBar) -> UIView {
        var platters: [UIView] = []
        func findPlatters(_ candidate: UIView) {
            if String(describing: type(of: candidate)).contains("Platter") {
                platters.append(candidate)
            }
            candidate.subviews.forEach(findPlatters)
        }
        findPlatters(bar)
        return platters.max { $0.bounds.width < $1.bounds.width } ?? bar
    }

}
