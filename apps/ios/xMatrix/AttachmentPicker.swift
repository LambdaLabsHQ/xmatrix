import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

enum AttachmentPickerSource: String {
    case photos
    case camera
    case files
}

struct StagedAttachment {
    let token: String
    let fileURL: URL
    let directoryURL: URL
    let name: String
    let mimeType: String
    let size: Int64
    let createdAt: Date

    var metadataPayload: [String: Any] {
        [
            "token": token,
            "name": name,
            "mimeType": mimeType,
            "size": size,
        ]
    }
}

/// Owns temporary copies of files chosen from native iOS pickers and serves them
/// to WebKit in bounded chunks so large videos never cross IPC as one string.
final class AttachmentStagingStore: @unchecked Sendable {
    static let maxEntries = 64
    static let entryTTL: TimeInterval = 600
    static let maxChunkBytes = 2 * 1024 * 1024

    private let lock = NSLock()
    private let rootDirectory: URL
    private let now: () -> Date
    private var entries: [String: StagedAttachment] = [:]

    init(
        rootDirectory: URL = FileManager.default.temporaryDirectory
            .appendingPathComponent("xmatrix-picked-attachments", isDirectory: true),
        now: @escaping () -> Date = Date.init
    ) {
        self.rootDirectory = rootDirectory
        self.now = now
    }

    deinit {
        releaseAll()
    }

    func stage(copying sourceURL: URL, suggestedName: String? = nil, mimeType: String? = nil) throws -> StagedAttachment {
        let token = UUID().uuidString.lowercased()
        let directory = rootDirectory.appendingPathComponent(token, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let rawName = suggestedName?.isEmpty == false ? suggestedName! : sourceURL.lastPathComponent
        let fileName = Self.sanitizedFilename(rawName, fallbackExtension: sourceURL.pathExtension)
        let destination = directory.appendingPathComponent(fileName)

        do {
            try FileManager.default.copyItem(at: sourceURL, to: destination)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }

        return try registerStagedFile(
            token: token,
            directory: directory,
            fileURL: destination,
            name: fileName,
            explicitMimeType: mimeType
        )
    }

    func stage(data: Data, name: String, mimeType: String) throws -> StagedAttachment {
        let token = UUID().uuidString.lowercased()
        let directory = rootDirectory.appendingPathComponent(token, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let fileName = Self.sanitizedFilename(name, fallbackExtension: UTType(mimeType: mimeType)?.preferredFilenameExtension)
        let destination = directory.appendingPathComponent(fileName)
        do {
            try data.write(to: destination, options: .atomic)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }

        return try registerStagedFile(
            token: token,
            directory: directory,
            fileURL: destination,
            name: fileName,
            explicitMimeType: mimeType
        )
    }

    func readChunk(token: String, offset: Int64, length: Int) throws -> [String: Any] {
        let entry: StagedAttachment? = lock.withLock {
            pruneExpiredLocked()
            return entries[token]
        }
        guard let entry else {
            throw NSError(
                domain: "sh.xmatrix.app",
                code: 404,
                userInfo: [NSLocalizedDescriptionKey: "Selected file is no longer available."]
            )
        }
        guard offset >= 0, length > 0 else {
            throw NSError(
                domain: "sh.xmatrix.app",
                code: 400,
                userInfo: [NSLocalizedDescriptionKey: "Invalid attachment chunk range."]
            )
        }

        if offset >= entry.size {
            return ["dataBase64": "", "bytesRead": 0, "eof": true]
        }

        let boundedLength = min(length, Self.maxChunkBytes)
        let handle = try FileHandle(forReadingFrom: entry.fileURL)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let data = try handle.read(upToCount: boundedLength) ?? Data()
        let eof = offset + Int64(data.count) >= entry.size || data.isEmpty
        return [
            "dataBase64": data.base64EncodedString(),
            "bytesRead": data.count,
            "eof": eof,
        ]
    }

    func release(token: String) {
        let removed: StagedAttachment? = lock.withLock {
            entries.removeValue(forKey: token)
        }
        if let removed {
            try? FileManager.default.removeItem(at: removed.directoryURL)
        }
    }

    func releaseAll() {
        let all: [StagedAttachment] = lock.withLock {
            let values = Array(entries.values)
            entries.removeAll()
            return values
        }
        for item in all {
            try? FileManager.default.removeItem(at: item.directoryURL)
        }
    }

    var count: Int {
        lock.withLock {
            pruneExpiredLocked()
            return entries.count
        }
    }

    private func registerStagedFile(
        token: String,
        directory: URL,
        fileURL: URL,
        name: String,
        explicitMimeType: String?
    ) throws -> StagedAttachment {
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let mimeType = Self.resolvedMimeType(explicit: explicitMimeType, filename: name)
        let staged = StagedAttachment(
            token: token,
            fileURL: fileURL,
            directoryURL: directory,
            name: name,
            mimeType: mimeType,
            size: size,
            createdAt: now()
        )
        let evicted: [StagedAttachment] = lock.withLock {
            var dropped = pruneExpiredLocked()
            entries[token] = staged
            while entries.count > Self.maxEntries {
                guard let oldest = entries.values.min(by: { $0.createdAt < $1.createdAt }) else { break }
                if let removed = entries.removeValue(forKey: oldest.token) {
                    dropped.append(removed)
                }
            }
            return dropped
        }
        for item in evicted {
            try? FileManager.default.removeItem(at: item.directoryURL)
        }
        return staged
    }

    @discardableResult
    private func pruneExpiredLocked() -> [StagedAttachment] {
        let cutoff = now().addingTimeInterval(-Self.entryTTL)
        let expiredTokens = entries.values.filter { $0.createdAt < cutoff }.map(\.token)
        var dropped: [StagedAttachment] = []
        for token in expiredTokens {
            if let removed = entries.removeValue(forKey: token) {
                dropped.append(removed)
            }
        }
        return dropped
    }

    static func sanitizedFilename(_ raw: String, fallbackExtension: String? = nil) -> String {
        let component = (raw as NSString).lastPathComponent
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: "\0", with: "")
        let ext = fallbackExtension?.trimmingCharacters(in: CharacterSet(charactersIn: ". ")) ?? ""
        if component.isEmpty || component == "." || component == ".." {
            return ext.isEmpty ? "attachment" : "attachment.\(ext)"
        }
        if (component as NSString).pathExtension.isEmpty, !ext.isEmpty {
            return "\(component).\(ext)"
        }
        return component
    }

    static func resolvedMimeType(explicit: String?, filename: String) -> String {
        if let explicit = explicit?.trimmingCharacters(in: .whitespacesAndNewlines), !explicit.isEmpty {
            return explicit
        }
        let ext = (filename as NSString).pathExtension
        if !ext.isEmpty, let type = UTType(filenameExtension: ext), let mime = type.preferredMIMEType {
            return mime
        }
        return "application/octet-stream"
    }
}

/// Presents native iOS Photos, Camera, or Files pickers directly so the composer
/// can own its own single-surface morph menu instead of WebKit's detached popover.
@MainActor
final class NativeAttachmentPicker: NSObject {
    weak var anchorView: UIView?
    let store: AttachmentStagingStore
    private var activeContinuation: CheckedContinuation<[[String: Any]], Error>?

    init(store: AttachmentStagingStore = AttachmentStagingStore()) {
        self.store = store
        super.init()
    }

    func pick(source: AttachmentPickerSource) async throws -> [[String: Any]] {
        guard let presenter = Self.topPresenter(from: anchorView) else {
            throw NSError(
                domain: "sh.xmatrix.app",
                code: 500,
                userInfo: [NSLocalizedDescriptionKey: "Could not open the attachment picker."]
            )
        }

        if let previous = activeContinuation {
            activeContinuation = nil
            previous.resume(returning: [])
        }

        switch source {
        case .photos:
            return try await withCheckedThrowingContinuation { continuation in
                activeContinuation = continuation
                var configuration = PHPickerConfiguration()
                configuration.selectionLimit = 0
                configuration.filter = .any(of: [.images, .videos])
                configuration.preferredAssetRepresentationMode = .compatible
                let picker = PHPickerViewController(configuration: configuration)
                picker.delegate = self
                picker.presentationController?.delegate = self
                presenter.present(picker, animated: true)
            }

        case .camera:
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                throw NSError(
                    domain: "sh.xmatrix.app",
                    code: 400,
                    userInfo: [NSLocalizedDescriptionKey: "Camera is not available on this device."]
                )
            }
            return try await withCheckedThrowingContinuation { continuation in
                activeContinuation = continuation
                let picker = UIImagePickerController()
                picker.sourceType = .camera
                let available = UIImagePickerController.availableMediaTypes(for: .camera) ?? []
                let wanted = [UTType.image.identifier, UTType.movie.identifier].filter { available.contains($0) }
                picker.mediaTypes = wanted.isEmpty ? [UTType.image.identifier] : wanted
                picker.videoQuality = .typeHigh
                picker.delegate = self
                picker.presentationController?.delegate = self
                presenter.present(picker, animated: true)
            }

        case .files:
            return try await withCheckedThrowingContinuation { continuation in
                activeContinuation = continuation
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
                picker.allowsMultipleSelection = true
                picker.delegate = self
                picker.presentationController?.delegate = self
                presenter.present(picker, animated: true)
            }
        }
    }

    nonisolated static func preferredTypeIdentifier(for registeredIdentifiers: [String]) -> String? {
        for identifier in registeredIdentifiers {
            if let type = UTType(identifier), type.conforms(to: .movie) {
                return identifier
            }
        }
        for identifier in registeredIdentifiers {
            if let type = UTType(identifier), type.conforms(to: .image) {
                return identifier
            }
        }
        return registeredIdentifiers.first
    }

    private func finish(_ result: Result<[[String: Any]], Error>) {
        guard let continuation = activeContinuation else { return }
        activeContinuation = nil
        switch result {
        case .success(let items):
            continuation.resume(returning: items)
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }

    private static func topPresenter(from view: UIView?) -> UIViewController? {
        guard var presenter = view?.window?.rootViewController else { return nil }
        while let presented = presenter.presentedViewController {
            presenter = presented
        }
        return presenter
    }

    private static func normalizedImageData(_ image: UIImage) -> Data? {
        if image.imageOrientation == .up {
            return image.jpegData(compressionQuality: 0.92)
        }
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        let rendered = UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
        return rendered.jpegData(compressionQuality: 0.92)
    }

    private static func timestampStem() -> String {
        String(Int(Date().timeIntervalSince1970))
    }
}

private final class StagedAttachmentBatch: @unchecked Sendable {
    private let lock = NSLock()
    private var stagedByIndex: [Int: StagedAttachment] = [:]
    private var firstError: Error?

    func record(index: Int, attachment: StagedAttachment) {
        lock.withLock { stagedByIndex[index] = attachment }
    }

    func record(error: Error) {
        lock.withLock {
            if firstError == nil { firstError = error }
        }
    }

    func result(count: Int) -> (payloads: [[String: Any]], error: Error?) {
        lock.withLock {
            let ordered = (0..<count).compactMap { stagedByIndex[$0]?.metadataPayload }
            return (ordered, firstError)
        }
    }
}

extension NativeAttachmentPicker: PHPickerViewControllerDelegate {
    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        Task { @MainActor [weak self] in
            picker.dismiss(animated: true)
            guard let self else { return }
            guard !results.isEmpty else {
                self.finish(.success([]))
                return
            }
            let stagingStore = self.store
            let group = DispatchGroup()
            let batch = StagedAttachmentBatch()

            for (index, item) in results.enumerated() {
                let provider = item.itemProvider
                guard let typeIdentifier = Self.preferredTypeIdentifier(for: provider.registeredTypeIdentifiers) else {
                    continue
                }
                let mimeType = UTType(typeIdentifier)?.preferredMIMEType
                let suggestedName = provider.suggestedName
                group.enter()
                provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                    defer { group.leave() }
                    if let error {
                        batch.record(error: error)
                        return
                    }
                    guard let url else { return }
                    do {
                        let ext = url.pathExtension.isEmpty
                            ? UTType(typeIdentifier)?.preferredFilenameExtension
                            : url.pathExtension
                        let rawName = suggestedName?.isEmpty == false ? suggestedName! : url.lastPathComponent
                        let name = AttachmentStagingStore.sanitizedFilename(rawName, fallbackExtension: ext)
                        let staged = try stagingStore.stage(copying: url, suggestedName: name, mimeType: mimeType)
                        batch.record(index: index, attachment: staged)
                    } catch {
                        batch.record(error: error)
                    }
                }
            }

            let totalCount = results.count
            group.notify(queue: .main) {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    let outcome = batch.result(count: totalCount)
                    if !outcome.payloads.isEmpty {
                        self.finish(.success(outcome.payloads))
                    } else if let firstError = outcome.error {
                        self.finish(.failure(firstError))
                    } else {
                        self.finish(.success([]))
                    }
                }
            }
        }
    }
}

extension NativeAttachmentPicker: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finish(.success([]))
    }

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        do {
            if let mediaURL = info[.mediaURL] as? URL {
                let ext = mediaURL.pathExtension.isEmpty ? "mov" : mediaURL.pathExtension
                let staged = try store.stage(
                    copying: mediaURL,
                    suggestedName: "video-\(Self.timestampStem()).\(ext)"
                )
                finish(.success([staged.metadataPayload]))
                return
            }
            if let imageURL = info[.imageURL] as? URL {
                let staged = try store.stage(copying: imageURL)
                finish(.success([staged.metadataPayload]))
                return
            }
            if let image = info[.originalImage] as? UIImage,
               let data = Self.normalizedImageData(image) {
                let staged = try store.stage(
                    data: data,
                    name: "photo-\(Self.timestampStem()).jpg",
                    mimeType: "image/jpeg"
                )
                finish(.success([staged.metadataPayload]))
                return
            }
            finish(.success([]))
        } catch {
            finish(.failure(error))
        }
    }
}

extension NativeAttachmentPicker: UIDocumentPickerDelegate {
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(.success([]))
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard !urls.isEmpty else {
            finish(.success([]))
            return
        }
        var payloads: [[String: Any]] = []
        var firstError: Error?
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let staged = try store.stage(copying: url)
                payloads.append(staged.metadataPayload)
            } catch {
                if firstError == nil { firstError = error }
            }
        }
        if !payloads.isEmpty {
            finish(.success(payloads))
        } else if let firstError {
            finish(.failure(firstError))
        } else {
            finish(.success([]))
        }
    }
}

extension NativeAttachmentPicker: UIAdaptivePresentationControllerDelegate {
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish(.success([]))
    }
}
