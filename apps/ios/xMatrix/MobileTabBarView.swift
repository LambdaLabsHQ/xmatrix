import SwiftUI
import UIKit

struct MobileTabState {
    var visible: Bool = false
    var activeView: String = "pages"
}

extension Notification.Name {
    static let xmatrixMobileTabStateChanged = Notification.Name("xmatrixMobileTabStateChanged")
    static let xmatrixMobileTabSelected = Notification.Name("xmatrixMobileTabSelected")
    /// The band the native dock covers above the home indicator, plus the
    /// capsule's side gap. The web layer already reads the home-indicator
    /// inset from env(); `height` is only the part above that inset, and
    /// `inset` is the gap from the right screen edge to the capsule.
    static let xmatrixMobileTabBarHeightChanged = Notification.Name("xmatrixMobileTabBarHeightChanged")
    /// The device's corner radius (`DisplayCorner.radius`) changed, so web
    /// surfaces that float at the bottom (the channel composer) can sit
    /// concentric with it. It is reported on its own: the dock can be hidden
    /// or unmeasured (an app opened straight into a channel) while the
    /// composer still needs it.
    static let xmatrixDisplayCornerRadiusChanged = Notification.Name("xmatrixDisplayCornerRadiusChanged")
}

/// The display corner radius as last measured, for observers that start
/// after the measurement (the web container, a reloaded page). 0 = not yet.
enum DisplayCorner {
    static var radius: CGFloat = 0
}

/// The dock's band as last reported, for observers that start after the
/// report (the web container, a reloaded page). A notification is not sticky:
/// a container that subscribed after the dock first laid out never heard it,
/// and the page then placed the + by its own fallback, off the dock's edge.
enum DockBand {
    /// The part of the dock above the home indicator. 0 = not yet measured.
    static var height: CGFloat = 0
    /// The gap from the right screen edge to the capsule.
    static var inset: CGFloat = 0
}

/// Where a capsule has to sit so its corners share a center with the device corners.
enum DockGeometry {
    /// A capsule rounder than the device cannot share that center. 12pt is the
    /// smallest gap that still reads as floating rather than glued to the bezel.
    static let minimumMargin: CGFloat = 12

    static func concentricMargin(deviceCornerRadius: CGFloat, capsuleRadius: CGFloat, floor: CGFloat = minimumMargin) -> CGFloat {
        max(deviceCornerRadius - capsuleRadius, floor)
    }

    /// Keep four tabs readable: the gap gives way before the capsule gets narrower than this.
    static func fittedMargin(proposed: CGFloat, boundsWidth: CGFloat, minimumCapsuleWidth: CGFloat = 240) -> CGFloat {
        let cap = max(0, (boundsWidth - minimumCapsuleWidth) / 2)
        return min(max(proposed, 0), cap)
    }
}

/// Every case must be a real `AppView` on the web side. A tab the web layer
/// does not recognize is dropped by its `isAppView` guard, which is how the
/// Follow-ups tab shipped inert: visible, and doing nothing when tapped.
/// Follow-ups is now Focus, a personal view *inside* Channels, not a
/// destination of its own.
enum MobileTabView: String, CaseIterable {
    // Pages come first: they are how the Space stands. The order and labels
    // match the web dock; agents, machines, schedules and the other tools live in More.
    case pages = "pages"
    case messages = "messages"
    case status = "status"
    case more = "more"

    var label: String {
        switch self {
        case .pages: return "Pages"
        case .messages: return "Channels"
        case .status: return "Status"
        case .more: return "More"
        }
    }

    var icon: String {
        switch self {
        case .pages: return "book.fill"
        case .messages: return "bubble.left.and.bubble.right.fill"
        case .status: return "gauge.with.needle"
        case .more: return "ellipsis"
        }
    }

    /// The tab that owns a web view, as the web dock's `dockTabOf` decides:
    /// Pages, Channels and Status own themselves; every other view, Agents
    /// included, is in More.
    static func tab(for activeView: String) -> Self {
        switch activeView {
        case "pages":
            return .pages
        case "messages":
            return .messages
        case "status":
            return .status
        default: return .more
        }
    }
}

struct MobileTabBarView: UIViewControllerRepresentable {
    @Binding var state: MobileTabState

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> NativeMobileTabBarController {
        let controller = NativeMobileTabBarController()
        controller.onTabSelected = { tab in
            context.coordinator.select(tab)
        }
        controller.apply(state)
        return controller
    }

    func updateUIViewController(_ controller: NativeMobileTabBarController, context: Context) {
        controller.apply(state)
    }

    final class Coordinator {
        func select(_ tab: MobileTabView) {
            NotificationCenter.default.post(
                name: .xmatrixMobileTabSelected,
                object: nil,
                userInfo: ["view": tab.rawValue]
            )
        }
    }
}

final class NativeMobileTabBarController: UIViewController, UITabBarDelegate {
    var onTabSelected: ((MobileTabView) -> Void)?

    private let mobileTabViews = MobileTabView.allCases
    private var mobileTabState = MobileTabState()
    private var reportedTabBarHeight: CGFloat = 0
    private var reportedInset: CGFloat = -1
    private var placementPasses = 0
    private var placementBounds: CGRect = .null
    private let tabBar = UITabBar()
    private let cornerReader = DisplayCornerReader()
    private var centerConstraint: NSLayoutConstraint?
    private var widthConstraint: NSLayoutConstraint?
    private var bottomConstraint: NSLayoutConstraint?

    override func loadView() {
        let passthroughView = TabBarPassthroughView()
        passthroughView.backgroundColor = .clear
        passthroughView.isOpaque = false
        view = passthroughView
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        // This controller is layered over the web view only to host the
        // system tab bar. It deliberately has no child content controller:
        // UITabBarController would install a full-screen content container
        // above the web view and can paint it black after the dock appears.
        view.backgroundColor = .clear
        view.isOpaque = false
        cornerReader.translatesAutoresizingMaskIntoConstraints = false
        tabBar.translatesAutoresizingMaskIntoConstraints = false
        tabBar.delegate = self
        // The bar's own safe-area padding would lift the platter back off the
        // device corner after the constraints put it there.
        tabBar.insetsLayoutMarginsFromSafeArea = false
        applyDockTint()
        tabBar.items = mobileTabViews.enumerated().map { index, tab in
            UITabBarItem(title: tab.label, image: UIImage(systemName: tab.icon), tag: index)
        }
        view.addSubview(cornerReader)
        view.addSubview(tabBar)
        let center = tabBar.centerXAnchor.constraint(equalTo: view.centerXAnchor)
        let width = tabBar.widthAnchor.constraint(equalTo: view.widthAnchor)
        // The screen edge, not the home-indicator inset. The platter's own
        // bottom gap is what floats the capsule; pinning to the safe area
        // stacked a second gap on top and the curve no longer shared a center
        // with the device corner.
        let bottom = tabBar.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        centerConstraint = center
        widthConstraint = width
        bottomConstraint = bottom
        NSLayoutConstraint.activate([
            cornerReader.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cornerReader.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            cornerReader.topAnchor.constraint(equalTo: view.topAnchor),
            cornerReader.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            center,
            width,
            bottom,
        ])
        (view as? TabBarPassthroughView)?.tabBar = tabBar
        apply(mobileTabState)
    }

    // The web layer draws every mobile surface under this bar, so it has to
    // know how much of the bottom the capsule takes. The number is the
    // capsule's top measured above the home indicator, not the tab bar's
    // bounds: those run to the screen edge and include the floating gap.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard view.bounds.width > 1, view.bounds.height > 1 else { return }
        if !placementBounds.equalTo(view.bounds) {
            placementBounds = view.bounds
            placementPasses = 0
        }
        // A pass spent waiting for the display radius does not count: the
        // reader resolves only once the view is in the window.
        if alignDockToDeviceCorners(adjustSize: placementPasses < 3), placementPasses < 3 {
            placementPasses += 1
        }
        reportDockBand()
    }

    /// Moves the system platter so its visible capsule is concentric with the
    /// device corners. The glass itself stays UIKit's; only the frame changes.
    /// Returns false until the display radius and the dock can be measured.
    private func alignDockToDeviceCorners(adjustSize: Bool) -> Bool {
        let platter = glassPlatter(in: tabBar)
        let dock = platter ?? tabBar
        guard dock.bounds.height > 1 else { return false }
        let platterFrame = dock.convert(dock.bounds, to: view)
        (view as? TabBarPassthroughView)?.dockPlatter = platter
        // UIKit can cap the platter width or change its internal layout after
        // our sizing passes. Center the visible glass independently on every
        // layout, even while the device corner radius is still unavailable.
        if let centerConstraint {
            let correction = view.bounds.midX - platterFrame.midX
            if abs(correction) > 0.5 {
                centerConstraint.constant += correction
            }
        }
        let deviceRadius = cornerReader.effectiveRadius(corner: .bottomLeft)
        guard deviceRadius > 1 else { return false }
        // The dock's ends are half circles. Left alone, the system platter
        // takes a radius from the device corner that is shorter than half its
        // height, and the continuous curve then runs a straight edge between
        // two long, flat bends: an oval corner, not a round one. A bar with no
        // platter is square and needs the same shape.
        let capsuleRadius = dock.bounds.height / 2
        if abs(dock.effectiveRadius(corner: .bottomLeft) - capsuleRadius) > 0.5 {
            dock.cornerConfiguration = .capsule()
        }
        let margin = DockGeometry.fittedMargin(
            proposed: DockGeometry.concentricMargin(deviceCornerRadius: deviceRadius, capsuleRadius: capsuleRadius),
            boundsWidth: view.bounds.width
        )
        let left = platterFrame.minX - view.bounds.minX
        let right = view.bounds.maxX - platterFrame.maxX
        let bottom = view.bounds.maxY - platterFrame.maxY
        if adjustSize {
            if let widthConstraint {
                let correction = left + right - 2 * margin
                if abs(correction) > 0.5 {
                    widthConstraint.constant += correction
                }
            }
            if let bottomConstraint, abs(bottom - margin) > 0.5 {
                bottomConstraint.constant -= margin - bottom
            }
        }
        return true
    }

    private func reportDockBand() {
        let platter = glassPlatter(in: tabBar)
        (view as? TabBarPassthroughView)?.dockPlatter = platter
        let dock = platter ?? tabBar
        guard dock.bounds.height > 1 else { return }
        let frame = dock.convert(dock.bounds, to: view)
        let fromScreenBottom = view.bounds.maxY - frame.minY
        let aboveSafeArea = fromScreenBottom - view.safeAreaInsets.bottom
        let inset = max(0, view.bounds.maxX - frame.maxX)
        guard aboveSafeArea > 0 else { return }
        guard abs(aboveSafeArea - reportedTabBarHeight) > 0.5 || abs(inset - reportedInset) > 0.5 else { return }
        reportedTabBarHeight = aboveSafeArea
        reportedInset = inset
        DockBand.height = aboveSafeArea
        DockBand.inset = inset
        NotificationCenter.default.post(
            name: .xmatrixMobileTabBarHeightChanged,
            object: nil,
            userInfo: ["height": aboveSafeArea, "inset": inset]
        )
    }

    /// The glass capsule iOS 26 draws inside a UITabBar. The widest match is
    /// the dock; a selection blob is narrower. Nil if this OS draws the bar
    /// itself, in which case the bar bounds are the capsule.
    private func glassPlatter(in bar: UITabBar) -> UIView? {
        var matches: [UIView] = []
        func walk(_ candidate: UIView) {
            if String(describing: type(of: candidate)).contains("Platter") {
                matches.append(candidate)
            }
            for child in candidate.subviews {
                walk(child)
            }
        }
        walk(bar)
        return matches.max { $0.bounds.width < $1.bounds.width }
    }

    // The web dock marks the active tab with the plain foreground color on a
    // glass pill; the app palette has no blue in it. Left alone, UITabBar
    // tints the selected item system blue, which reads as stock iOS chrome
    // rather than our dock. Only the tints are overridden — installing a
    // UITabBarAppearance here would also replace the bar's own background
    // material, which is the part that already matches the web dock.
    private func applyDockTint() {
        tabBar.tintColor = .label
        tabBar.unselectedItemTintColor = .secondaryLabel
    }

    func apply(_ state: MobileTabState) {
        mobileTabState = state
        guard isViewLoaded else { return }

        view.isHidden = !state.visible
        let tab = MobileTabView.tab(for: state.activeView)
        guard let index = mobileTabViews.firstIndex(of: tab), let items = tabBar.items else { return }
        tabBar.selectedItem = items[index]
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard
            let index = tabBar.items?.firstIndex(where: { $0 === item }),
            mobileTabViews.indices.contains(index)
        else {
            return
        }

        onTabSelected?(mobileTabViews[index])
    }
}

private final class TabBarPassthroughView: UIView {
    weak var tabBar: UITabBar?
    weak var dockPlatter: UIView?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let tabBar, !tabBar.isHidden else { return nil }
        let dock = dockPlatter ?? tabBar
        let local = dock.convert(point, from: self)
        guard dock.point(inside: local, with: event) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// Full-screen so `containerConcentric` resolves to the display corner radius.
/// The radius resolves only once the view is in the window, so it reports
/// whenever it changes rather than when someone happens to ask; a hidden
/// dock still keeps this view in the window and laid out.
private final class DisplayCornerReader: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        cornerConfiguration = .corners(radius: .containerConcentric())
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        reportRadius()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        reportRadius()
    }

    private func reportRadius() {
        guard window != nil else { return }
        let radius = effectiveRadius(corner: .bottomLeft)
        // 0 means "not resolved yet" as often as "square corners"; a square
        // display needs no report, since the web floor already applies.
        guard radius > 1, abs(radius - DisplayCorner.radius) > 0.5 else { return }
        DisplayCorner.radius = radius
        NotificationCenter.default.post(name: .xmatrixDisplayCornerRadiusChanged, object: nil)
    }
}
