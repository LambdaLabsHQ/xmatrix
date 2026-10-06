import SwiftUI

@main
struct XMatrixApp: App {
    @StateObject private var router = AppRouter()
    @State private var mobileTabState = MobileTabState()

    var body: some Scene {
        WindowGroup {
            ZStack {
                WebContainerView(router: router)
                    .ignoresSafeArea()

                MobileTabBarView(state: $mobileTabState)
                    .ignoresSafeArea()
            }
            .onOpenURL { url in
                router.open(url)
            }
            .onReceive(NotificationCenter.default.publisher(for: .xmatrixMobileTabStateChanged)) { notification in
                if let state = notification.object as? MobileTabState {
                    mobileTabState = state
                }
            }
        }
    }
}
