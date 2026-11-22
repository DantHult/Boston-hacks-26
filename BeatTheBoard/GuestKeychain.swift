import Foundation
import Security

enum GuestKeychain {
    private struct Failure: LocalizedError {
        let status: OSStatus

        var errorDescription: String? {
            "The guest credential could not be accessed in Keychain (\(status))."
        }
    }

    private static func query(for server: URL) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "org.beattheboard.ios.guest",
            kSecAttrAccount as String: server.absoluteString
        ]
    }

    static func read(for server: URL) throws -> String? {
        var request = query(for: server)
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        request[kSecReturnData as String] = true

        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure(status: status) }
        guard let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
            throw Failure(status: errSecDecode)
        }
        return token
    }

    static func save(_ token: String, for server: URL) throws {
        let request = query(for: server)
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(request as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw Failure(status: status) }

        var item = request
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw Failure(status: addStatus) }
    }

    static func remove(for server: URL) throws {
        let status = SecItemDelete(query(for: server) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Failure(status: status)
        }
    }
}
