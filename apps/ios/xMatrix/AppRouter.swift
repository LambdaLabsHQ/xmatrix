import Foundation

final class AppRouter: ObservableObject {
    @Published var pendingDeepLink: URL?

    func open(_ url: URL) {
        pendingDeepLink = url
    }
}
