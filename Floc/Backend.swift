import Foundation
import CryptoKit
import Security

/// The floc server: accounts, the list of published events, and their download packages.
/// Launch with `-apiBase http://localhost:5190` to use a server on the Mac (simulator).
enum Backend {
    static var base: URL {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-apiBase"), i + 1 < args.count, let u = URL(string: args[i + 1]) { return u }
        return URL(string: "https://floc-server-production.up.railway.app")!
    }

    struct User: Codable { let id: String; let email: String; let name: String }
    struct AuthResponse: Codable { let user: User; let token: String? }
    struct Event: Codable, Identifiable, Hashable {
        let id: String
        let name: String
        let notes: String
        let organizer: String?
        let version: Int
        let size: Int
    }
    struct ReleaseFile: Codable { let path: String; let size: Int; let sha256: String; let url: String? }
    struct Release: Codable { let id: String; let version: Int; let name: String; let size: Int; let files: [ReleaseFile] }

    struct APIError: LocalizedError { let message: String; var errorDescription: String? { message } }

    static func request<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        var req = URLRequest(url: base.appendingPathComponent("api/v1" + path))
        req.httpMethod = method
        req.timeoutInterval = 30
        if let token = Keychain.token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401, Keychain.token != nil, !path.hasPrefix("/auth/") {
            Keychain.token = nil
            await MainActor.run { Session.shared.signedOut() }
        }
        guard (200..<300).contains(status) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError(message: msg ?? "Er ging iets mis (\(status))")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func login(email: String, password: String) async throws -> AuthResponse {
        try await request("POST", "/auth/login", body: ["email": email, "password": password, "client": "app"])
    }
    static func register(email: String, password: String, name: String) async throws -> AuthResponse {
        try await request("POST", "/auth/register", body: ["email": email, "password": password, "name": name, "client": "app"])
    }
    static func logout() async {
        struct Ok: Decodable {}
        _ = try? await request("POST", "/auth/logout") as Ok
    }
    static func events() async throws -> [Event] { try await request("GET", "/events") }
    static func release(_ id: String) async throws -> Release { try await request("GET", "/events/\(id)/release") }
}

/// Who is signed in. Floc needs an account (decided 2026-11-22).
@MainActor
final class Session: ObservableObject {
    static let shared = Session()
    @Published private(set) var email: String? = UserDefaults.standard.string(forKey: "floc.email")
    var signedIn: Bool { Keychain.token != nil && email != nil }

    func signedIn(_ r: Backend.AuthResponse) {
        Keychain.token = r.token
        email = r.user.email
        UserDefaults.standard.set(r.user.email, forKey: "floc.email")
    }
    func signedOut() {
        Keychain.token = nil
        email = nil
        UserDefaults.standard.removeObject(forKey: "floc.email")
    }
    func logout() async {
        await Backend.logout()
        signedOut()
    }
}

/// Session token in the Keychain (not UserDefaults).
enum Keychain {
    private static let service = "nl.floc.session"
    static var token: String? {
        get {
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
            var out: AnyObject?
            guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
            return String(data: d, encoding: .utf8)
        }
        set {
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
            SecItemDelete(q as CFDictionary)
            guard let v = newValue else { return }
            var add = q
            add[kSecValueData as String] = Data(v.utf8)
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}

/// Downloaded events live in Application Support/events/<id>/, readable offline like a bundled map folder.
@MainActor
final class EventStore: ObservableObject {
    static let shared = EventStore()

    enum State: Equatable { case idle, downloading(Double), failed(String) }

    @Published var events: [Backend.Event] = []
    @Published var loadError: String?
    @Published var loading = false
    @Published var states: [String: State] = [:]
    /// Installed version per event id.
    @Published private(set) var installed: [String: Int] = [:]

    static let root: URL = {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("events")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        var v = URLResourceValues(); v.isExcludedFromBackup = true
        var r = u; try? r.setResourceValues(v)
        return u
    }()
    static func folder(_ id: String) -> URL { root.appendingPathComponent(id) }
    private static func versionFile(_ id: String) -> URL { folder(id).appendingPathComponent(".floc-release.json") }

    init() { scanInstalled() }

    private func scanInstalled() {
        var out: [String: Int] = [:]
        for dir in (try? FileManager.default.contentsOfDirectory(at: Self.root, includingPropertiesForKeys: nil)) ?? [] {
            guard let d = try? Data(contentsOf: dir.appendingPathComponent(".floc-release.json")),
                  let r = try? JSONDecoder().decode(Backend.Release.self, from: d) else { continue }
            out[dir.lastPathComponent] = r.version
        }
        installed = out
    }

    /// Installed events that are on this phone (also when offline or no longer listed).
    var installedMaps: [EventMap] {
        installed.keys.sorted().compactMap { MapLoader.load(folder: Self.folder($0)) }
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        do { events = try await Backend.events(); loadError = nil }
        catch { loadError = error.localizedDescription }
    }

    func hasUpdate(_ e: Backend.Event) -> Bool { (installed[e.id] ?? 0) < e.version && installed[e.id] != nil }

    /// Downloads the latest package. Files that didn't change since the installed version
    /// (same sha256, e.g. the big aerial photo) are copied locally instead of downloaded.
    func download(_ id: String) async {
        states[id] = .downloading(0)
        do {
            let rel = try await Backend.release(id)
            let fm = FileManager.default
            let staging = Self.root.appendingPathComponent(".\(id)-v\(rel.version)")
            try? fm.removeItem(at: staging)
            try fm.createDirectory(at: staging, withIntermediateDirectories: true)
            let old = Self.folder(id)
            let oldRelease = (try? Data(contentsOf: Self.versionFile(id))).flatMap { try? JSONDecoder().decode(Backend.Release.self, from: $0) }
            let oldHashes = Dictionary((oldRelease?.files ?? []).map { ($0.path, $0.sha256) }, uniquingKeysWith: { a, _ in a })
            let total = max(1, rel.files.reduce(0) { $0 + $1.size })
            var done = 0
            for f in rel.files {
                let dest = staging.appendingPathComponent(f.path)
                try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                let local = old.appendingPathComponent(f.path)
                if oldHashes[f.path] == f.sha256, fm.fileExists(atPath: local.path) {
                    try fm.copyItem(at: local, to: dest)
                } else {
                    guard let s = f.url, let url = URL(string: s) else { throw Backend.APIError(message: "Geen downloadlink voor \(f.path)") }
                    let base = done
                    let tmp = try await Self.fetch(url) { got in
                        Task { @MainActor in self.states[id] = .downloading(Double(base + got) / Double(total)) }
                    }
                    guard try Self.sha256(tmp) == f.sha256 else { throw Backend.APIError(message: "\(f.path) is beschadigd binnengekomen. Probeer het opnieuw.") }
                    try fm.moveItem(at: tmp, to: dest)
                }
                done += f.size
                states[id] = .downloading(Double(done) / Double(total))
            }
            try JSONEncoder().encode(rel).write(to: staging.appendingPathComponent(".floc-release.json"))
            // Swap in the new version in one go, so a half download never replaces a working map.
            if fm.fileExists(atPath: old.path) { _ = try fm.replaceItemAt(old, withItemAt: staging) }
            else { try fm.moveItem(at: staging, to: old) }
            installed[id] = rel.version
            states[id] = .idle
        } catch {
            states[id] = .failed(error.localizedDescription)
        }
    }

    func remove(_ id: String) {
        try? FileManager.default.removeItem(at: Self.folder(id))
        installed[id] = nil
    }

    private static func fetch(_ url: URL, progress: @escaping (Int) -> Void) async throws -> URL {
        try await Downloader(progress: progress).run(url)
    }

    private static func sha256(_ file: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: file)
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try h.read(upToCount: 4 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// One file download with progress (a download task writes straight to disk, fast for 200 MB files).
private final class Downloader: NSObject, URLSessionDownloadDelegate {
    private let progress: (Int) -> Void
    private var cont: CheckedContinuation<URL, Error>?
    init(progress: @escaping (Int) -> Void) { self.progress = progress }

    func run(_ url: URL) async throws -> URL {
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return try await withCheckedThrowingContinuation { c in
            cont = c
            session.downloadTask(with: url).resume()
        }
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite _: Int64) {
        progress(Int(totalBytesWritten))
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { cont?.resume(throwing: Backend.APIError(message: "Download mislukt (\(code))")); cont = nil; return }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        do { try FileManager.default.moveItem(at: location, to: tmp); cont?.resume(returning: tmp) }
        catch { cont?.resume(throwing: error) }
        cont = nil
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { cont?.resume(throwing: error); cont = nil }
    }
}
