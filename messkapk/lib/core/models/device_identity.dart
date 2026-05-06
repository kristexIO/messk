import 'dart:convert';

class DeviceIdentity {
  const DeviceIdentity({
    required this.deviceId,
    required this.signingPublicKey,
    required this.exchangePublicKey,
    required this.createdAtUtc,
  });

  factory DeviceIdentity.fromJson(Map<String, dynamic> json) {
    return DeviceIdentity(
      deviceId: json['deviceId'] as String,
      signingPublicKey: json['signingPublicKey'] as String,
      exchangePublicKey: json['exchangePublicKey'] as String,
      createdAtUtc: DateTime.parse(json['createdAtUtc'] as String),
    );
  }

  final String deviceId;
  final String signingPublicKey; // Ed25519 Base64
  final String exchangePublicKey; // X25519 Base64
  final DateTime createdAtUtc;

  String get shortFingerprint {
    final compact = signingPublicKey
        .replaceAll(RegExp(r'[^A-Za-z0-9]'), '')
        .toUpperCase();
    if (compact.length < 16) {
      return compact;
    }
    return '${compact.substring(0, 4)} ${compact.substring(4, 8)} ${compact.substring(8, 12)} ${compact.substring(12, 16)}';
  }

  Map<String, dynamic> toJson() {
    return {
      'deviceId': deviceId,
      'signingPublicKey': signingPublicKey,
      'exchangePublicKey': exchangePublicKey,
      'createdAtUtc': createdAtUtc.toIso8601String(),
    };
  }

  String toEncodedJson() => jsonEncode(toJson());
}
