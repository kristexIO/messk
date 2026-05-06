import 'dart:convert';

import '../models/secure_session.dart';
import 'secure_storage_service.dart';

class SessionVaultService {
  SessionVaultService({required SecureStorageService secureStorage})
    : _secureStorage = secureStorage;

  static const _sessionKey = 'messk_secure_session_v1';

  final SecureStorageService _secureStorage;

  Future<SecureSession?> loadSession() async {
    final raw = await _secureStorage.read(_sessionKey);
    if (raw == null || raw.isEmpty) {
      return null;
    }

    try {
      return SecureSession.fromJson(
        Map<String, dynamic>.from(jsonDecode(raw) as Map<String, dynamic>),
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> saveSession(SecureSession session) {
    return _secureStorage.write(_sessionKey, session.toEncodedJson());
  }

  Future<void> clear() => _secureStorage.delete(_sessionKey);
}
