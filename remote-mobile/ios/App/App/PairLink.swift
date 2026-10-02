import Foundation

/// The pairing link agmux shows as a QR code on the Mac:
/// `https://remote.agmux.dev#pair=CODE&desktopId=ID` (or the same keys in the query).
enum PairLink {
    static func isPairLink(_ text: String) -> Bool {
        guard let url = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        var items = url.queryItems ?? []
        if let fragment = url.fragment {
            var fragmentQuery = URLComponents()
            fragmentQuery.query = fragment
            items += fragmentQuery.queryItems ?? []
        }
        func has(_ name: String) -> Bool { items.contains { $0.name == name && !($0.value ?? "").isEmpty } }
        return has("pair") && (has("desktopId") || has("desktop"))
    }
}
