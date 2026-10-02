import Foundation
import Security
import os

/// One generic-password Keychain item, readable after first unlock and never
/// restored to another device (a phone pairing belongs to this phone only).
struct KeychainStore {
    let service: String
    let account: String

    private static let log = Logger(subsystem: "dev.agmux.remote", category: "keychain")

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func read() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            if status != errSecItemNotFound { Self.log.error("read failed: \(status, privacy: .public)") }
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    func write(_ value: String) -> Bool {
        let data = Data(value.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else {
            Self.log.error("update failed: \(status, privacy: .public)")
            return false
        }
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        if addStatus != errSecSuccess { Self.log.error("add failed: \(addStatus, privacy: .public)") }
        return addStatus == errSecSuccess
    }

    func delete() {
        let status = SecItemDelete(baseQuery as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            Self.log.error("delete failed: \(status, privacy: .public)")
        }
    }
}
