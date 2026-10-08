import StoreKit
import UIKit

@MainActor
final class AppleSubscriptions {
    private var purchaseInProgress = false
    private func eligible(_ ids: [String]) throws -> Set<String> {
        guard !ids.isEmpty, ids.count <= 8, ids.allSatisfy({ !$0.isEmpty && $0.count <= 200 }) else {
            throw failure("Subscription products are unavailable.")
        }
        return Set(ids)
    }

    func products(_ ids: [String]) async throws -> [[String: Any]] {
        let allowed = try eligible(ids)
        return try await Product.products(for: allowed).filter { $0.type == .autoRenewable }.map { product in
            ["id": product.id, "displayName": product.displayName, "displayPrice": product.displayPrice]
        }
    }

    func purchase(productId: String, appAccountToken: String, productIds: [String]) async throws -> [String: Any] {
        guard !purchaseInProgress else { throw failure("A purchase is already in progress.") }
        purchaseInProgress = true
        defer { purchaseInProgress = false }
        let allowed = try eligible(productIds)
        guard allowed.contains(productId), let token = UUID(uuidString: appAccountToken) else {
            throw failure("The subscription purchase could not be prepared.")
        }
        // This UI guard prevents an accidental cross-Space purchase. The server
        // independently enforces the immutable transaction/Space binding.
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result, allowed.contains(transaction.productID) else { continue }
            if transaction.appAccountToken != token {
                throw failure("Your App Store subscription is bound to another Space. Rebinding is not supported.")
            }
        }
        for id in allowed {
            if let result = await Transaction.latest(for: id), case .verified(let previous) = result,
               let previousToken = previous.appAccountToken, previousToken != token {
                throw failure("This App Store purchase history belongs to another Space. Restore it there; rebinding is not supported.")
            }
        }
        guard let product = try await Product.products(for: [productId]).first, product.type == .autoRenewable else {
            throw failure("This subscription is not available in the App Store.")
        }
        switch try await product.purchase(options: [.appAccountToken(token)]) {
        case .success(let result):
            guard case .verified(let transaction) = result else { throw failure("Apple purchase verification failed.") }
            return ["status": "purchased", "transaction": try payload(transaction)]
        case .pending:
            return ["status": "pending"]
        case .userCancelled:
            return ["status": "cancelled"]
        @unknown default:
            throw failure("The App Store returned an unknown purchase state.")
        }
    }

    func purchases(productIds: [String], restore: Bool) async throws -> [[String: Any]] {
        let allowed = try eligible(productIds)
        if restore { try await AppStore.sync() }
        var transactions: [UInt64: [String: Any]] = [:]
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result, allowed.contains(transaction.productID) {
                transactions[transaction.id] = try payload(transaction)
                if transactions.count >= 20 { break }
            }
        }
        for await result in Transaction.unfinished {
            if case .verified(let transaction) = result, allowed.contains(transaction.productID) {
                transactions[transaction.id] = try payload(transaction)
                if transactions.count >= 20 { break }
            }
        }
        return Array(transactions.values)
    }

    func finish(transactionId: String) async throws {
        guard let id = UInt64(transactionId) else { throw failure("Invalid transaction.") }
        var count = 0
        for await result in Transaction.unfinished {
            count += 1
            if case .verified(let transaction) = result, transaction.id == id {
                await transaction.finish()
                return
            }
            if count >= 100 { break }
        }
    }

    func manage() async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }) else {
            throw failure("Open the app to manage subscriptions.")
        }
        try await AppStore.showManageSubscriptions(in: scene)
    }

    private func payload(_ transaction: Transaction) throws -> [String: Any] {
        let environment: String
        switch transaction.environment {
        case .production: environment = "Production"
        case .sandbox: environment = "Sandbox"
        default: throw failure("Local test purchases cannot activate a server subscription.")
        }
        return ["transactionId": String(transaction.id), "originalTransactionId": String(transaction.originalID),
                "productId": transaction.productID, "environment": environment]
    }

    private func failure(_ message: String) -> NSError {
        NSError(domain: "sh.xmatrix.app.subscriptions", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
