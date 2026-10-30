import AuthenticationServices
import UIKit

/// Signing in without leaving the app. Google and GitHub open the Hub's
/// sign-in page in the system sign-in sheet, which returns to the app's
/// `xmatrix://auth` address with a one-time code only this app can redeem
/// (the page keeps its PKCE verifier). Sign in with Apple is native and
/// returns Apple's identity token for the page to sign in with.
/// Bounded facts for one Sign in with Apple attempt. Each token is from a
/// fixed vocabulary. The nonce, window identity and account data are absent.
struct AppleAuthorizationFacts: Equatable {
    var anchor = "none"
    var presented = false
    var phase = "active"
    var nonce = "empty"
    var extra = false
}

@MainActor
final class AppSignIn: NSObject {
    static let callbackScheme = "xmatrix"
    static let callbackURL = "xmatrix://auth"
    /// The browser defect report keeps 300 characters, including the Web's
    /// "Apple sign-in native authorization failed: " prefix (43). Stay under it.
    static let diagnosticCharacterLimit = 250

    /// The view whose window the sign-in sheet is shown over.
    weak var anchorView: UIView?
    private var webSession: ASWebAuthenticationSession?
    private var appleRequest: (controller: ASAuthorizationController,
                               continuation: CheckedContinuation<[String: Any], Error>)?
    /// Window captured when the attempt starts, so presentation still has a
    /// real window if the page's view has detached.
    private var heldWindow: UIWindow?
    private var attemptFacts = AppleAuthorizationFacts()

    /// Opens the Hub's sign-in start page with this app as its return address and answers where it returned.
    func authorize(url value: String, redirectParam: String, ephemeral: Bool) async throws -> String {
        guard
            let url = URL(string: value),
            Self.isHubSignInStart(url),
            redirectParam.range(of: "^[a-z_]{1,32}$", options: .regularExpression) != nil,
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else {
            throw NSError(domain: "sh.xmatrix.app", code: 400,
                          userInfo: [NSLocalizedDescriptionKey: "Not an xMatrix sign-in page"])
        }
        components.queryItems = (components.queryItems ?? []).filter { $0.name != redirectParam }
            + [URLQueryItem(name: redirectParam, value: Self.callbackURL)]
        guard let start = components.url else {
            throw NSError(domain: "sh.xmatrix.app", code: 400,
                          userInfo: [NSLocalizedDescriptionKey: "Not an xMatrix sign-in page"])
        }

        webSession?.cancel()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: start, callback: .customScheme(Self.callbackScheme)) { callback, error in
                if let callback {
                    continuation.resume(returning: callback.absoluteString)
                } else {
                    continuation.resume(throwing: error ?? CancellationError())
                }
            }
            session.presentationContextProvider = self
            // Without saved browser sign-ins, so another account can be chosen.
            session.prefersEphemeralWebBrowserSession = ephemeral
            webSession = session
            if !session.start() {
                continuation.resume(throwing: NSError(domain: "sh.xmatrix.app", code: 500,
                    userInfo: [NSLocalizedDescriptionKey: "The sign-in sheet couldn't open"]))
            }
        }
    }

    /// Sign in with Apple for `nonce` (already hashed by the page): Apple's identity token and, the first time, the name.
    func signInWithApple(nonce: String) async throws -> [String: Any] {
        heldWindow = existingWindow()
        attemptFacts = currentFacts(nonce: nonce, presented: false)
        if let refusal = refusalMessage(nonce: nonce) {
            heldWindow = nil
            throw Self.reported(refusal)
        }

        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = nonce
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        // Drop the previous attempt before its controller can complete this one.
        let previous = appleRequest
        appleRequest = nil
        previous?.continuation.resume(throwing: CancellationError())
        return try await withCheckedThrowingContinuation { continuation in
            appleRequest = (controller, continuation)
            controller.performRequests()
        }
    }

    /// Why this attempt must not ask Apple, as the same diagnostic string a
    /// later authorization failure uses. Empty nonce and a missing window both
    /// surface as authorization error 1000 with no underlying error.
    func refusalMessage(nonce: String) -> String? {
        let blocked = Self.preflightChains(hasWindow: existingWindow() != nil, nonce: nonce)
        guard !blocked.isEmpty else { return nil }
        return Self.diagnosticMessage(chain: blocked, facts: currentFacts(nonce: nonce, presented: false))
    }

    /// The person closed the sheet or turned the request down.
    nonisolated static func isCancellation(_ error: Error) -> Bool {
        if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { return true }
        if let error = error as? ASAuthorizationError, error.code == .canceled { return true }
        return false
    }

    /// Reasons to stop before Apple is asked. A missing window and an empty
    /// nonce otherwise both come back as authorization:1000 with no underlying error.
    nonisolated static func preflightChains(hasWindow: Bool, nonce: String) -> [String] {
        var chain: [String] = []
        if !hasWindow { chain.append("presentation:no_window") }
        if nonce.isEmpty { chain.append("nonce:empty") }
        return chain
    }

    /// `ok` is a 64-character hex SHA-256. Anything else is `bad` or `empty`.
    /// The nonce itself is never copied into a diagnostic.
    nonisolated static func nonceKind(_ nonce: String) -> String {
        if nonce.isEmpty { return "empty" }
        if nonce.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil { return "ok" }
        return "bad"
    }

    nonisolated static func phaseKind(_ state: UIApplication.State) -> String {
        switch state {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "other"
        }
    }

    /// Diagnostics for an otherwise opaque Apple authorization failure. Never
    /// serialize NSError descriptions, userInfo values or unknown key names:
    /// they can contain account data. `facts` records the attempt; without it
    /// the message stays the chain and the build, for a failure that never
    /// reached an attempt.
    nonisolated static func authorizationFailureMessage(_ error: Error, facts: AppleAuthorizationFacts? = nil) -> String? {
        let native = error as NSError
        guard native.domain == ASAuthorizationError.errorDomain else { return nil }
        let parsed = authorizationChain(native)
        guard var facts else {
            return boundedDiagnostic(chain: parsed.chain, facts: nil)
        }
        facts.extra = facts.extra || parsed.extra
        return diagnosticMessage(chain: parsed.chain, facts: facts)
    }

    /// The attempt's own failure, before Apple is asked, in the same shape.
    nonisolated static func diagnosticMessage(chain: [String], facts: AppleAuthorizationFacts) -> String {
        boundedDiagnostic(chain: chain, facts: facts)
    }

    nonisolated static func reported(_ message: String) -> NSError {
        NSError(domain: "sh.xmatrix.app", code: 422,
                userInfo: [NSLocalizedDescriptionKey: message])
    }

    /// The one Hub that the beta and stable Webs both sign in through.
    private static let hubHost = "xmatrix-hub.xmatrix.sh"

    /// The Hub's sign-in start page, on exactly the Hub's https origin: the only page the sheet opens.
    static func isHubSignInStart(_ url: URL) -> Bool {
        guard url.scheme == "https", url.host?.lowercased() == hubHost, url.port == nil || url.port == 443,
              url.user == nil, url.password == nil else {
            return false
        }
        return url.path == "/api/auth/app/start"
    }

    private nonisolated static func authorizationChain(_ error: NSError) -> (chain: [String], extra: Bool) {
        let domains = [
            ASAuthorizationError.errorDomain: "authorization",
            "AKAuthenticationError": "authentication",
            "AKAuthenticationErrorDomain": "authentication",
            "AKAuthenticationServerError": "authentication_server",
            "AKSQLError": "authentication_store",
            NSURLErrorDomain: "url", NSCocoaErrorDomain: "cocoa",
            NSPOSIXErrorDomain: "posix", NSOSStatusErrorDomain: "os_status"
        ]
        let allowed: Set<String> = [
            NSUnderlyingErrorKey, NSLocalizedDescriptionKey,
            NSLocalizedFailureReasonErrorKey, NSLocalizedRecoverySuggestionErrorKey,
        ]
        func unlisted(_ cause: NSError) -> Bool {
            cause.userInfo.keys.contains { !allowed.contains($0) }
        }
        var chain: [String] = []
        var extra = false
        var current: NSError? = error
        for _ in 0..<3 {
            guard let cause = current else { break }
            chain.append("\(domains[cause.domain] ?? "other"):\(cause.code)")
            extra = extra || unlisted(cause)
            if let raw = cause.userInfo[NSUnderlyingErrorKey] {
                if let next = raw as? NSError {
                    current = next
                } else {
                    chain.append("underlying:other")
                    current = nil
                }
            } else {
                current = nil
            }
        }
        if current != nil { chain.append("more") }
        return (chain, extra)
    }

    private nonisolated static func boundedDiagnostic(chain: [String], facts: AppleAuthorizationFacts?) -> String {
        func version(_ key: String) -> String {
            guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
                  value.range(of: "^[0-9][0-9A-Za-z.+-]{0,23}$", options: .regularExpression) != nil
            else { return "unknown" }
            return value
        }
        func token(_ value: String) -> String {
            value.range(of: "^[a-z0-9_]{1,24}$", options: .regularExpression) != nil ? value : "other"
        }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let versions = "app=\(version("CFBundleShortVersionString")); build=\(version("CFBundleVersion")); "
            + "ios=\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        let lead = "Apple authorization failed: \(chain.joined(separator: " > "))"
        let factText = facts.map { facts in
            "anchor=\(token(facts.anchor)); presented=\(facts.presented ? "1" : "0"); "
                + "phase=\(token(facts.phase)); nonce=\(token(facts.nonce)); extra=\(facts.extra ? "1" : "0")"
        }
        let withFacts = factText.map { "\(lead); \($0)" } ?? lead
        let full = "\(withFacts); \(versions)"
        if full.count <= diagnosticCharacterLimit { return full }
        if withFacts.count <= diagnosticCharacterLimit { return withFacts }
        // A long chain must not push the attempt facts out of the defect report.
        if let factText {
            let tail = "; \(factText)"
            let room = diagnosticCharacterLimit - tail.count
            if room > "Apple authorization failed: ".count {
                return String(lead.prefix(room)) + tail
            }
            return String(factText.prefix(diagnosticCharacterLimit))
        }
        return String(lead.prefix(diagnosticCharacterLimit))
    }

    private func finishApple(_ result: Result<[String: Any], Error>) {
        guard let request = appleRequest else { return }
        appleRequest = nil
        heldWindow = nil
        switch result {
        case .success(let value):
            request.continuation.resume(returning: value)
        case .failure(let error) where Self.isCancellation(error):
            request.continuation.resume(throwing: error)
        case .failure(let error):
            var facts = attemptFacts
            facts.phase = Self.phaseKind(UIApplication.shared.applicationState)
            if let message = Self.authorizationFailureMessage(error, facts: facts) {
                request.continuation.resume(throwing: Self.reported(message))
            } else {
                request.continuation.resume(throwing: error)
            }
        }
    }

    private func currentFacts(nonce: String, presented: Bool) -> AppleAuthorizationFacts {
        AppleAuthorizationFacts(
            anchor: anchorToken(returning: existingWindow() ?? heldWindow),
            presented: presented,
            phase: Self.phaseKind(UIApplication.shared.applicationState),
            nonce: Self.nonceKind(nonce),
            extra: false
        )
    }

    /// `view` is the page, `scene` is another window on screen, `held` is the
    /// window captured when the attempt started, and `none` means Apple would
    /// be shown on a window that does not exist.
    private func anchorToken(returning window: UIWindow?) -> String {
        guard let window else { return "none" }
        if let viewWindow = anchorView?.window, window === viewWindow { return "view" }
        if let scene = sceneWindow(), window === scene { return "scene" }
        return "held"
    }

    private func existingWindow() -> UIWindow? {
        anchorView?.window ?? sceneWindow()
    }

    private func sceneWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        func rank(_ scene: UIWindowScene) -> Int {
            switch scene.activationState {
            case .foregroundActive: return 0
            case .foregroundInactive: return 1
            default: return 2
            }
        }
        for scene in scenes.sorted(by: { rank($0) < rank($1) }) {
            if let key = scene.windows.first(where: \.isKeyWindow) { return key }
            if let visible = scene.windows.first(where: { !$0.isHidden }) { return visible }
        }
        return nil
    }

    private var presentationWindow: ASPresentationAnchor {
        existingWindow() ?? ASPresentationAnchor()
    }
}

extension AppSignIn: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { presentationWindow }
    }
}

extension AppSignIn: ASAuthorizationControllerPresentationContextProviding, ASAuthorizationControllerDelegate {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let window = existingWindow() ?? heldWindow
            if controller === appleRequest?.controller {
                attemptFacts.presented = true
                attemptFacts.anchor = anchorToken(returning: window)
            }
            return window ?? ASPresentationAnchor()
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController,
                                             didCompleteWithAuthorization authorization: ASAuthorization) {
        let credential = authorization.credential as? ASAuthorizationAppleIDCredential
        let token = credential?.identityToken.flatMap { String(data: $0, encoding: .utf8) }
        let givenName = credential?.fullName?.givenName
        let familyName = credential?.fullName?.familyName
        MainActor.assumeIsolated {
            guard controller === appleRequest?.controller else { return }
            guard let token else {
                finishApple(.failure(NSError(domain: "sh.xmatrix.app", code: 500,
                    userInfo: [NSLocalizedDescriptionKey: "Apple returned no identity token"])))
                return
            }
            var result: [String: Any] = ["identityToken": token]
            if let givenName { result["givenName"] = givenName }
            if let familyName { result["familyName"] = familyName }
            finishApple(.success(result))
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated {
            guard controller === appleRequest?.controller else { return }
            finishApple(.failure(error))
        }
    }
}
