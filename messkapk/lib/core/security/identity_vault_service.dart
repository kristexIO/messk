import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../models/device_identity.dart';
import 'secure_storage_service.dart';

class IdentityVaultService {
  IdentityVaultService({required SecureStorageService secureStorage})
    : _secureStorage = secureStorage;

  static const _identityKey = 'messk_device_identity_v2';
  static const _signingSecretKey = 'messk_signing_secret_v2';
  static const _exchangeSecretKey = 'messk_exchange_secret_v2';

  final SecureStorageService _secureStorage;
  final Random _random = Random.secure();

  final _ed25519 = Ed25519();
  final _x25519 = X25519();

  Future<DeviceIdentity?> loadIdentity() async {
    final raw = await _secureStorage.read(_identityKey);
    if (raw == null || raw.isEmpty) {
      return null;
    }

    try {
      return DeviceIdentity.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<DeviceIdentity> createIdentity() async {
    // 1. Generate Signing Key (Ed25519)
    final signingKeyPair = await _ed25519.newKeyPair();
    final signingPublicKey = await signingKeyPair.extractPublicKey();
    final signingSecret = await signingKeyPair.extractPrivateKeyBytes();

    // 2. Generate Exchange Key (X25519)
    final exchangeKeyPair = await _x25519.newKeyPair();
    final exchangePublicKey = await exchangeKeyPair.extractPublicKey();
    final exchangeSecret = await exchangeKeyPair.extractPrivateKeyBytes();

    final deviceId = _generateHexId(16);

    final identity = DeviceIdentity(
      deviceId: deviceId,
      signingPublicKey: base64Encode(signingPublicKey.bytes),
      exchangePublicKey: base64Encode(exchangePublicKey.bytes),
      createdAtUtc: DateTime.now().toUtc(),
    );

    // 3. Store in secure storage
    await Future.wait([
      _secureStorage.write(_identityKey, identity.toEncodedJson()),
      _secureStorage.write(_signingSecretKey, base64Encode(signingSecret)),
      _secureStorage.write(_exchangeSecretKey, base64Encode(exchangeSecret)),
    ]);

    return identity;
  }

  Future<void> wipeIdentity() async {
    await Future.wait([
      _secureStorage.delete(_identityKey),
      _secureStorage.delete(_signingSecretKey),
      _secureStorage.delete(_exchangeSecretKey),
    ]);
  }

  String _generateHexId(int length) {
    final bytes = Uint8List(length);
    for (var i = 0; i < length; i++) {
      bytes[i] = _random.nextInt(256);
    }
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
