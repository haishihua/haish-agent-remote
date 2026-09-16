import Foundation
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import Capacitor

/// App-local Capacitor plugin that opens the system photo picker (`PHPickerViewController`)
/// directly, as a half-cover sheet, so tapping the composer's image button lands in the album
/// grid in one tap instead of going through the `Photo Library / Take Photo / Choose Files`
/// action sheet that WKWebView shows for `<input type="file">`.
@objc(PhotoPicker)
public class PhotoPicker: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotoPicker"
    public let jsName = "PhotoPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickImages", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?
    private static let fileQueue = DispatchQueue(label: "com.haish.agent.remote.photo-picker")

    @objc func pickImages(_ call: CAPPluginCall) {
        let limit = call.getInt("limit") ?? 0

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.pendingCall == nil else {
                call.reject("The photo picker is already open.")
                return
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("The photo picker is not available.")
                return
            }

            var configuration = PHPickerConfiguration(photoLibrary: PHPhotoLibrary.shared())
            configuration.filter = .images
            configuration.selectionLimit = limit > 0 ? limit : 0
            // Ask for a representation the conversation can hold: HEIC assets come back as JPEG.
            configuration.preferredAssetRepresentationMode = .compatible

            let picker = PHPickerViewController(configuration: configuration)
            picker.delegate = self
            // A page sheet keeps the conversation visible behind the picker, the way the system
            // photo sheet behaves in other apps.
            picker.modalPresentationStyle = .pageSheet

            // Drop the composer keyboard first, otherwise it would cover the sheet's grid.
            presenter.view.endEditing(true)

            self.pendingCall = call
            presenter.present(picker, animated: true, completion: nil)
        }
    }
}

extension PhotoPicker: PHPickerViewControllerDelegate {
    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let call = pendingCall
        pendingCall = nil
        picker.dismiss(animated: true, completion: nil)

        guard let call = call else { return }
        guard !results.isEmpty else {
            call.reject("No photo was picked.", "cancelled")
            return
        }

        var picked = [URL?](repeating: nil, count: results.count)
        let group = DispatchGroup()

        for (index, result) in results.enumerated() {
            guard let typeIdentifier = PhotoPicker.imageTypeIdentifier(for: result.itemProvider) else { continue }
            group.enter()
            _ = result.itemProvider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
                defer { group.leave() }
                guard let url = url, let copy = PhotoPicker.copyToTemporaryFile(url) else { return }
                PhotoPicker.fileQueue.sync {
                    picked[index] = copy
                }
            }
        }

        group.notify(queue: .main) { [weak self] in
            let photos: [[String: Any]] = picked.compactMap { $0 }.map { file in
                var entry: [String: Any] = [
                    "path": file.path,
                    "name": file.lastPathComponent
                ]
                if let webURL = self?.bridge?.portablePath(fromLocalURL: file) {
                    entry["webPath"] = webURL.absoluteString
                }
                return entry
            }
            call.resolve(["photos": photos])
        }
    }

    private static func imageTypeIdentifier(for provider: NSItemProvider) -> String? {
        if let imageIdentifier = provider.registeredTypeIdentifiers.first(where: { identifier in
            UTType(identifier)?.conforms(to: .image) ?? false
        }) {
            return imageIdentifier
        }
        return provider.registeredTypeIdentifiers.first
    }

    private static func copyToTemporaryFile(_ source: URL) -> URL? {
        let fileManager = FileManager.default
        let ext = source.pathExtension.isEmpty ? "jpg" : source.pathExtension
        // The URL handed to `loadFileRepresentation` is only readable while the completion runs,
        // so copy it somewhere the web layer can fetch it from.
        let destination = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("haish-photo-\(UUID().uuidString).\(ext)")
        do {
            try fileManager.copyItem(at: source, to: destination)
        } catch {
            CAPLog.print("⚡️ ", "PhotoPicker", "-", "could not copy the picked photo:", error.localizedDescription)
            return nil
        }
        return destination
    }
}
