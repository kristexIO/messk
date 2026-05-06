import 'dart:convert';

class SecureSession {
  const SecureSession({
    required this.sessionToken,
    required this.createdAtUtc,
    required this.lastUsedAtUtc,
  });

  factory SecureSession.fromJson(Map<String, dynamic> json) {
    return SecureSession(
      sessionToken: json['sessionToken'] as String,
      createdAtUtc: DateTime.parse(json['createdAtUtc'] as String),
      lastUsedAtUtc: DateTime.parse(json['lastUsedAtUtc'] as String),
    );
  }

  final String sessionToken;
  final DateTime createdAtUtc;
  final DateTime lastUsedAtUtc;

  Map<String, dynamic> toJson() {
    return {
      'sessionToken': sessionToken,
      'createdAtUtc': createdAtUtc.toIso8601String(),
      'lastUsedAtUtc': lastUsedAtUtc.toIso8601String(),
    };
  }

  String toEncodedJson() => jsonEncode(toJson());
}
