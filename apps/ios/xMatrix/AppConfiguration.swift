import Foundation

enum AppConfiguration {
    static let appScheme = "xmatrix"
    static let cliInstallURL = URL(string: "https://xmatrix.sh/docs")!
    private static let fallbackURL = URL(string: "https://xmatrix.sh/app")!

    static var startURL: URL {
        let configured = Bundle.main.object(forInfoDictionaryKey: "XMatrixWebURL") as? String
        return normalizeAppURL(configured.flatMap(URL.init(string:)) ?? fallbackURL)
    }

    static func normalizeAppURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return fallbackURL
        }

        if components.path.isEmpty || components.path == "/" {
            components.path = "/app"
        }

        return components.url ?? fallbackURL
    }

    static func appURL(path: String, queryItems: [URLQueryItem] = []) -> URL {
        guard var components = URLComponents(url: startURL, resolvingAgainstBaseURL: false) else {
            return fallbackURL
        }

        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        return components.url ?? fallbackURL
    }

    static func mobileTabURL(_ tab: MobileTabView) -> URL {
        guard var components = URLComponents(url: startURL, resolvingAgainstBaseURL: false) else {
            return fallbackURL
        }

        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "view" || $0.name == "channel" }
        queryItems.append(URLQueryItem(name: "view", value: tab.rawValue))
        components.queryItems = queryItems
        return components.url ?? fallbackURL
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
        if url.scheme == appScheme {
            return true
        }

        guard let scheme = url.scheme, ["http", "https"].contains(scheme), let host = url.host else {
            return false
        }

        if scheme == "https" && isXMatrixHost(host) {
            return true
        }

        #if DEBUG
        return ["localhost", "127.0.0.1", "::1"].contains(host)
        #else
        return false
        #endif
    }

    static func isTrustedAppPage(_ url: URL?) -> Bool {
        guard let url, url.scheme == "https", let host = url.host else {
            return false
        }

        return isXMatrixHost(host)
    }

    private static func isXMatrixHost(_ host: String) -> Bool {
        host == "xmatrix.sh" || host == "www.xmatrix.sh" || host == "test.xmatrix.sh"
    }
}
