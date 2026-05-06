import 'package:dio/dio.dart';

import '../config/app_config.dart';
import '../models/backend_status.dart';

class ApiClient {
  ApiClient({required AppConfig config})
    : _dio = Dio(
        BaseOptions(
          baseUrl: config.apiBaseUrl,
          connectTimeout: const Duration(seconds: 12),
          receiveTimeout: const Duration(seconds: 20),
          sendTimeout: const Duration(seconds: 20),
          headers: const {'Accept': 'application/json'},
        ),
      );

  final Dio _dio;

  Future<String> healthStatus() async {
    final response = await _dio.get<Map<String, dynamic>>('/health');
    return response.data?['status']?.toString() ?? 'unknown';
  }

  Future<BackendStatus> fetchBackendStatus() async {
    final healthResponse = await _dio.get<Map<String, dynamic>>('/health');
    final versionResponse = await _dio.get<Map<String, dynamic>>('/version');

    final health = healthResponse.data?['status']?.toString() ?? 'unknown';
    final versionPayload = versionResponse.data ?? const <String, dynamic>{};

    return BackendStatus(
      health: health,
      version: versionPayload['version']?.toString() ?? 'unknown',
      commit: versionPayload['commit']?.toString() ?? 'unknown',
      builtAt: versionPayload['builtAt']?.toString() ?? 'unknown',
    );
  }
}
