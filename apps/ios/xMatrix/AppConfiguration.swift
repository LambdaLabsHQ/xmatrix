import Foundation

enum AppConfiguration {
    static let appScheme = "xmatrix"
    static let cliInstallURL = URL(string: "https://xmatrix.sh/docs")!
    /// The Web this build loads and trusts: its `XMatrixWebURL`, which a beta
    /// TestFlight build sets to the beta Web (scripts/ios-testflight.sh).
    static let web = AppWeb(configured: Bundle.main.object(forInfoDictionaryKey: "XMatrixWebURL") as? String)

    static var startURL: URL { web.startURL }

    static func appURL(path: String, queryItems: [URLQueryItem] = []) -> URL {
        guard var components = URLComponents(url: startURL, resolvingAgainstBaseURL: false) else {
            return startURL
        }

        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        return components.url ?? startURL
    }

    static func mobileTabURL(_ tab: MobileTabView) -> URL {
        guard var components = URLComponents(url: startURL, resolvingAgainstBaseURL: false) else {
            return startURL
        }

        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "view" || $0.name == "channel" }
        queryItems.append(URLQueryItem(name: "view", value: tab.rawValue))
        components.queryItems = queryItems
        return components.url ?? startURL
    }

    static func mapDeepLink(_ url: URL) -> URL {
        guard url.scheme == appScheme else {
            return startURL
        }

        if url.host == "channel" {
            let channelId = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !channelId.isEmpty {
                return appURL(
                    path: "/app",
                    queryItems: [URLQueryItem(name: "channel", value: channelId.removingPercentEncoding ?? channelId)]
                )
            }
        }

        if url.host == "login" {
            var components = URLComponents(url: appURL(path: "/login"), resolvingAgainstBaseURL: false)
            components?.percentEncodedQuery = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery
            return components?.url ?? appURL(path: "/login")
        }

        return appURL(path: "/app")
    }

    static func isTrustedNavigation(_ url: URL) -> Bool {
        web.isTrustedNavigation(url)
    }

    static func isTrustedAppPage(_ url: URL?) -> Bool {
        web.isTrustedAppPage(url)
    }
}

/// The Web a build loads, and the only pages it trusts to navigate in place
/// and call the bridge: https pages on exactly that Web's host. The stable Web
/// keeps its `www` name; a beta build trusts the beta Web alone, never the
/// stable Web, a sibling host or a lookalike.
struct AppWeb {
    /// The stable Web, which a build without a configured Web loads.
    static let stableURL = URL(string: "https://xmatrix.sh/app")!

    let startURL: URL
    private let trustedHosts: Set<String>

    /// `configured` is the build's `XMatrixWebURL`; without a usable one the
    /// build loads the stable Web.
    init(configured: String?) {
        let configuredURL = configured.flatMap(URL.init(string:)).flatMap { url -> URL? in
            ["http", "https"].contains(url.scheme ?? "") && !(url.host ?? "").isEmpty ? url : nil
        }
        let start = Self.appPage(configuredURL ?? Self.stableURL)
        let host = start.host?.lowercased() ?? ""
        startURL = start
        trustedHosts = host == Self.stableURL.host ? [host, "www.\(host)"] : [host]
    }

    func isTrustedNavigation(_ url: URL) -> Bool {
        if url.scheme == AppConfiguration.appScheme || isOwnPage(url) {
            return true
        }

        #if DEBUG
        guard let scheme = url.scheme, ["http", "https"].contains(scheme), let host = url.host else {
            return false
        }
        return ["localhost", "127.0.0.1", "::1"].contains(host)
        #else
        return false
        #endif
    }

    func isTrustedAppPage(_ url: URL?) -> Bool {
        guard let url else {
            return false
        }

        return isOwnPage(url)
    }

    /// An https page on exactly this Web's host, at the default port.
    private func isOwnPage(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host, url.port == nil || url.port == 443 else {
            return false
        }

        return trustedHosts.contains(host.lowercased())
    }

    /// A Web's address as the app page it opens: its root becomes `/app`.
    private static func appPage(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return stableURL
        }

        if components.path.isEmpty || components.path == "/" {
            components.path = "/app"
        }

        return components.url ?? stableURL
    }
}
