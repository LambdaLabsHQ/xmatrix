import AuthenticationServices
import UIKit

/// Signing in without leaving the app. Google and GitHub open the Hub's
/// sign-in page in the system sign-in sheet, which returns to the app's
/// `xmatrix://auth` address with a one-time code only this app can redeem
/// (the page keeps its PKCE verifier). Sign in with Apple is native and
/// returns Apple's identity token for the page to sign in with.
@MainActor
final class AppSignIn: NSObject {
    static let callbackScheme = "xmatrix"
    static let callbackURL = "xmatrix://auth"

    /// The view whose window the sign-in sheet is shown over.
    weak var anchorView: UIView?
    private var webSession: ASWebAuthenticationSession?
    private var appleRequest: (controller: ASAuthorizationController,
                               continuation: CheckedContinuation<[String: Any], Error>)?

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
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = nonce
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        appleRequest?.continuation.resume(throwing: CancellationError())
        return try await withCheckedThrowingContinuation { continuation in
            appleRequest = (controller, continuation)
            controller.performRequests()
        }
    }

    /// The person closed the sheet or turned the request down.
    nonisolated static func isCancellation(_ error: Error) -> Bool {
        if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { return true }
        if let error = error as? ASAuthorizationError, error.code == .canceled { return true }
        return false
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

    private func finishApple(_ result: Result<[String: Any], Error>) {
        guard let request = appleRequest else { return }
        appleRequest = nil
        request.continuation.resume(with: result)
    }

    private var presentationWindow: ASPresentationAnchor {
        anchorView?.window
            ?? UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
            ?? ASPresentationAnchor()
    }
}

extension AppSignIn: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { presentationWindow }
    }
}

extension AppSignIn: ASAuthorizationControllerPresentationContextProviding, ASAuthorizationControllerDelegate {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated { presentationWindow }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController,
                                             didCompleteWithAuthorization authorization: ASAuthorization) {
        let credential = authorization.credential as? ASAuthorizationAppleIDCredential
        let token = credential?.identityToken.flatMap { String(data: $0, encoding: .utf8) }
        let givenName = credential?.fullName?.givenName
        let familyName = credential?.fullName?.familyName
        MainActor.assumeIsolated {
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
        MainActor.assumeIsolated { finishApple(.failure(error)) }
    }
}
