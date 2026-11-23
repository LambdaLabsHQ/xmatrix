import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

enum AttachmentPickerSource: String {
    case photos
    case camera
    case files
}

enum AttachmentStagingError: Error, Equatable {
    case capacityReached
}

struct StagedAttachment {
    let token: String
    let fileURL: URL
    let directoryURL: URL
    let name: String
    let createdAt: Date
}

/// Keeps temporary copies of picked media and documents on disk long enough for
/// WebKit's disk-backed `File` objects to finish preview, compression, upload,
/// and retries, while bounding count and lifetime on disk. Live entries are
/// never silently evicted out from under WebKit; staging fails closed once the
/// store is at capacity until expired entries age out or tokens are released.
final class AttachmentStagingStore: @unchecked Sendable {
    static let maxEntries = 256
    static let maxBatchSelection = 64
    static let entryTTL: TimeInterval = 7200

    private let lock = NSLock()
    private let rootDirectory: URL
    private let now: () -> Date
    private let maxEntries: Int
    private var entries: [String: StagedAttachment] = [:]

    init(
        rootDirectory: URL = FileManager.default.temporaryDirectory
            .appendingPathComponent("xmatrix-picked-attachments", isDirectory: true),
        now: @escaping () -> Date = Date.init,
        maxEntries: Int = AttachmentStagingStore.maxEntries,
        purgeExistingOnInit: Bool = true
    ) {
        self.rootDirectory = rootDirectory
        self.now = now
        self.maxEntries = max(1, maxEntries)
        if purgeExistingOnInit {
            try? FileManager.default.removeItem(at: rootDirectory)
        }
    }

    deinit {
        releaseAll()
    }

    func stage(copying sourceURL: URL, suggestedName: String? = nil) throws -> StagedAttachment {
        let rawName = suggestedName?.isEmpty == false ? suggestedName! : sourceURL.lastPathComponent
        return try stageFile(rawName: rawName, fallbackExtension: sourceURL.pathExtension) { destination in
            try FileManager.default.copyItem(at: sourceURL, to: destination)
        }
    }

    func stage(data: Data, name: String, fallbackExtension: String? = nil) throws -> StagedAttachment {
        try stageFile(rawName: name, fallbackExtension: fallbackExtension) { destination in
            try data.write(to: destination, options: .atomic)
        }
    }

    private func stageFile(
        rawName: String,
        fallbackExtension: String?,
        write: (URL) throws -> Void
    ) throws -> StagedAttachment {
        try ensureCapacity()

        let token = UUID().uuidString.lowercased()
        let directory = rootDirectory.appendingPathComponent(token, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let fileName = Self.sanitizedFilename(rawName, fallbackExtension: fallbackExtension)
        let destination = directory.appendingPathComponent(fileName)
        do {
            try write(destination)
            return try registerStagedFile(token: token, directory: directory, fileURL: destination, name: fileName)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
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
        let dropped: [StagedAttachment] = lock.withLock {
            pruneExpiredLocked()
        }
        for item in dropped {
            try? FileManager.default.removeItem(at: item.directoryURL)
        }
        return lock.withLock { entries.count }
    }

    private func ensureCapacity() throws {
        let result: (dropped: [StagedAttachment], hasRoom: Bool) = lock.withLock {
            let dropped = pruneExpiredLocked()
            return (dropped, entries.count < maxEntries)
        }
        for item in result.dropped {
            try? FileManager.default.removeItem(at: item.directoryURL)
        }
        guard result.hasRoom else {
            throw AttachmentStagingError.capacityReached
        }
    }

    private func registerStagedFile(
        token: String,
        directory: URL,
        fileURL: URL,
        name: String
    ) throws -> StagedAttachment {
        let staged = StagedAttachment(
            token: token,
            fileURL: fileURL,
            directoryURL: directory,
            name: name,
            createdAt: now()
        )
        let outcome: (dropped: [StagedAttachment], accepted: Bool) = lock.withLock {
            let dropped = pruneExpiredLocked()
            guard entries.count < maxEntries else {
                return (dropped, false)
            }
            entries[token] = staged
            return (dropped, true)
        }
        for item in outcome.dropped {
            try? FileManager.default.removeItem(at: item.directoryURL)
        }
        guard outcome.accepted else {
            throw AttachmentStagingError.capacityReached
        }
        return staged
    }

    @discardableResult
    private func pruneExpiredLocked() -> [StagedAttachment] {
        let cutoff = now().addingTimeInterval(-Self.entryTTL)
        let expiredTokens = entries.values
            .filter { $0.createdAt < cutoff }
            .map(\.token)
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
}

private final class StagedURLBatch: @unchecked Sendable {
    private let lock = NSLock()
    private var urlsByIndex: [Int: URL] = [:]

    func record(index: Int, url: URL) {
        lock.withLock { urlsByIndex[index] = url }
    }

    func orderedURLs(count: Int) -> [URL] {
        lock.withLock {
            (0..<count).compactMap { urlsByIndex[$0] }
        }
    }
}

private final class OpenPanelCompletionBox: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (([URL]?) -> Void)?

    init(_ handler: @escaping ([URL]?) -> Void) {
        self.handler = handler
    }

    func complete(_ urls: [URL]?) {
        let pending: (([URL]?) -> Void)? = lock.withLock {
            let current = handler
            handler = nil
            return current
        }
        guard let pending else { return }
        if let urls, !urls.isEmpty {
            pending(urls)
        } else {
            pending(nil)
        }
    }

    deinit {
        complete(nil)
    }
}

/// Fulfills `WKUIDelegate.webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:)`
/// with native iOS pickers and hands disk-backed file URLs straight back to WebKit.
@MainActor
final class NativeAttachmentPicker: NSObject {
    static let readArmedSourceScript = """
    (() => {
      const record = window.__xmatrixPendingAttachmentSource;
      window.__xmatrixPendingAttachmentSource = null;
      if (!record || typeof record !== "object") return null;
      if (typeof record.expiresAt === "number" && record.expiresAt < Date.now()) return null;
      return typeof record.source === "string" ? record.source : null;
    })();
    """

    weak var anchorView: UIView?
    let store: AttachmentStagingStore
    private var activeCompletion: OpenPanelCompletionBox?

    init(store: AttachmentStagingStore = AttachmentStagingStore()) {
        self.store = store
        super.init()
    }

    nonisolated static func parseArmedSource(_ raw: Any?) -> AttachmentPickerSource? {
        guard let value = raw as? String else { return nil }
        return AttachmentPickerSource(rawValue: value)
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

    func presentOpenPanel(
        source: AttachmentPickerSource?,
        allowsMultipleSelection: Bool,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        // Cancel any superseded open panel so WebKit never leaks an uncalled completion.
        finish(nil)

        guard let presenter = Self.topPresenter(from: anchorView) else {
            completionHandler(nil)
            return
        }

        activeCompletion = OpenPanelCompletionBox(completionHandler)
        if let source {
            present(source: source, allowsMultipleSelection: allowsMultipleSelection, from: presenter)
        } else {
            presentSourceChooser(allowsMultipleSelection: allowsMultipleSelection, from: presenter)
        }
    }

    private func presentSourceChooser(allowsMultipleSelection: Bool, from presenter: UIViewController) {
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Photo Library", style: .default) { [weak self] _ in
            guard let self, let current = Self.topPresenter(from: self.anchorView) else {
                self?.finish(nil)
                return
            }
            self.present(source: .photos, allowsMultipleSelection: allowsMultipleSelection, from: current)
        })
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            let cameraTitle = allowsMultipleSelection ? "Take Photo or Video" : "Take Photo"
            sheet.addAction(UIAlertAction(title: cameraTitle, style: .default) { [weak self] _ in
                guard let self, let current = Self.topPresenter(from: self.anchorView) else {
                    self?.finish(nil)
                    return
                }
                self.present(source: .camera, allowsMultipleSelection: allowsMultipleSelection, from: current)
            })
        }
        sheet.addAction(UIAlertAction(title: "Choose Files", style: .default) { [weak self] _ in
            guard let self, let current = Self.topPresenter(from: self.anchorView) else {
                self?.finish(nil)
                return
            }
            self.present(source: .files, allowsMultipleSelection: allowsMultipleSelection, from: current)
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            self?.finish(nil)
        })
        if let popover = sheet.popoverPresentationController, let anchor = anchorView ?? presenter.view {
            popover.sourceView = anchor
            popover.sourceRect = CGRect(x: anchor.bounds.midX, y: anchor.bounds.maxY - 24, width: 1, height: 1)
        }
        sheet.presentationController?.delegate = self
        presenter.present(sheet, animated: true)
    }

    private func present(
        source: AttachmentPickerSource,
        allowsMultipleSelection: Bool,
        from presenter: UIViewController
    ) {
        switch source {
        case .photos:
            var configuration = PHPickerConfiguration()
            configuration.selectionLimit = allowsMultipleSelection ? AttachmentStagingStore.maxBatchSelection : 1
            configuration.filter = allowsMultipleSelection ? .any(of: [.images, .videos]) : .images
            configuration.preferredAssetRepresentationMode = .compatible
            let picker = PHPickerViewController(configuration: configuration)
            picker.delegate = self
            picker.presentationController?.delegate = self
            presenter.present(picker, animated: true)

        case .camera:
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                finish(nil)
                let alert = UIAlertController(
                    title: "Camera unavailable",
                    message: "Camera is not available on this device.",
                    preferredStyle: .alert
                )
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                presenter.present(alert, animated: true)
                return
            }
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            let available = UIImagePickerController.availableMediaTypes(for: .camera) ?? []
            let wanted = allowsMultipleSelection
                ? [UTType.image.identifier, UTType.movie.identifier].filter { available.contains($0) }
                : [UTType.image.identifier].filter { available.contains($0) }
            picker.mediaTypes = wanted.isEmpty ? [UTType.image.identifier] : wanted
            picker.videoQuality = .typeHigh
            picker.delegate = self
            picker.presentationController?.delegate = self
            presenter.present(picker, animated: true)

        case .files:
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = allowsMultipleSelection
            picker.delegate = self
            picker.presentationController?.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    private func finish(_ urls: [URL]?) {
        let completion = activeCompletion
        activeCompletion = nil
        completion?.complete(urls)
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

extension NativeAttachmentPicker: PHPickerViewControllerDelegate {
    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        Task { @MainActor [weak self] in
            picker.dismiss(animated: true)
            guard let self else { return }
            guard !results.isEmpty else {
                self.finish(nil)
                return
            }
            let stagingStore = self.store
            let group = DispatchGroup()
            let batch = StagedURLBatch()

            for (index, item) in results.prefix(AttachmentStagingStore.maxBatchSelection).enumerated() {
                let provider = item.itemProvider
                guard let typeIdentifier = Self.preferredTypeIdentifier(for: provider.registeredTypeIdentifiers) else {
                    continue
                }
                let suggestedName = provider.suggestedName
                group.enter()
                provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
                    defer { group.leave() }
                    guard let url else { return }
                    let ext = url.pathExtension.isEmpty
                        ? UTType(typeIdentifier)?.preferredFilenameExtension
                        : url.pathExtension
                    let rawName = suggestedName?.isEmpty == false ? suggestedName! : url.lastPathComponent
                    let name = AttachmentStagingStore.sanitizedFilename(rawName, fallbackExtension: ext)
                    if let staged = try? stagingStore.stage(copying: url, suggestedName: name) {
                        batch.record(index: index, url: staged.fileURL)
                    }
                }
            }

            let totalCount = min(results.count, AttachmentStagingStore.maxBatchSelection)
            group.notify(queue: .main) {
                Task { @MainActor [weak self] in
                    self?.finish(batch.orderedURLs(count: totalCount))
                }
            }
        }
    }
}

extension NativeAttachmentPicker: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finish(nil)
    }

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        if let mediaURL = info[.mediaURL] as? URL {
            let ext = mediaURL.pathExtension.isEmpty ? "mov" : mediaURL.pathExtension
            let staged = try? store.stage(copying: mediaURL, suggestedName: "video-\(Self.timestampStem()).\(ext)")
            finish(staged.map { [$0.fileURL] })
            return
        }
        if let imageURL = info[.imageURL] as? URL {
            let staged = try? store.stage(copying: imageURL)
            finish(staged.map { [$0.fileURL] })
            return
        }
        if let image = info[.originalImage] as? UIImage,
           let data = Self.normalizedImageData(image) {
            let staged = try? store.stage(
                data: data,
                name: "photo-\(Self.timestampStem()).jpg",
                fallbackExtension: "jpg"
            )
            finish(staged.map { [$0.fileURL] })
            return
        }
        finish(nil)
    }
}

extension NativeAttachmentPicker: UIDocumentPickerDelegate {
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(nil)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard !urls.isEmpty else {
            finish(nil)
            return
        }
        var stagedURLs: [URL] = []
        for url in urls.prefix(AttachmentStagingStore.maxBatchSelection) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let staged = try store.stage(copying: url)
                stagedURLs.append(staged.fileURL)
            } catch AttachmentStagingError.capacityReached {
                break
            } catch {
                continue
            }
        }
        finish(stagedURLs)
    }
}

extension NativeAttachmentPicker: UIAdaptivePresentationControllerDelegate {
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish(nil)
    }
}
