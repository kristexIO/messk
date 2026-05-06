import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/config/app_config.dart';
import '../../core/database/database_service.dart';
import '../../core/models/backend_status.dart';
import '../../core/models/device_identity.dart';
import '../../core/network/api_client.dart';
import '../../core/network/realtime_client.dart';
import '../../core/repositories/chat_repository.dart';
import '../../core/security/identity_vault_service.dart';
import '../../core/security/session_vault_service.dart';
import '../../core/security/secure_storage_service.dart';
import 'bootstrap_state.dart';

class AppBootstrapController extends ChangeNotifier {
  AppBootstrapController({
    required this.config,
    required this.secureStorage,
    required this.identityVault,
    required this.apiClient,
    required this.realtimeClient,
    required this.databaseService,
    required this.sessionVault,
    required this.chatRepository,
  });

  final AppConfig config;
  final SecureStorageService secureStorage;
  final IdentityVaultService identityVault;
  final ApiClient apiClient;
  final RealtimeClient realtimeClient;
  final DatabaseService databaseService;
  final SessionVaultService sessionVault;
  final ChatRepository chatRepository;

  BootstrapState _state = const BootstrapState.loading();

  BootstrapState get state => _state;

  Future<void> initialize() async {
    _state = const BootstrapState.loading();
    notifyListeners();

    try {
      await databaseService.initialize();
      final identity = await identityVault.loadIdentity();
      if (identity == null) {
        _state = const BootstrapState.needsIdentity();
      } else {
        final session = await sessionVault.loadSession();
        await chatRepository.seedWelcomeThread(identity);
        final backendStatus = await _safeFetchBackendStatus();
        _state = BootstrapState.ready(
          identity: identity,
          session: session,
          backendStatus: backendStatus,
        );
      }
    } catch (error) {
      _state = BootstrapState.failure(errorMessage: 'Bootstrap failed: $error');
    }

    notifyListeners();
  }

  Future<void> createIdentity() async {
    _state = const BootstrapState.loading();
    notifyListeners();

    try {
      await databaseService.initialize();
      final identity = await identityVault.createIdentity();
      await chatRepository.seedWelcomeThread(identity);
      final session = await sessionVault.loadSession();
      final backendStatus = await _safeFetchBackendStatus();
      _state = BootstrapState.ready(
        identity: identity,
        session: session,
        backendStatus: backendStatus,
      );
    } catch (error) {
      _state = BootstrapState.failure(
        errorMessage: 'Identity creation failed: $error',
      );
    }

    notifyListeners();
  }

  Future<void> wipeIdentity() async {
    await identityVault.wipeIdentity();
    await sessionVault.clear();
    _state = const BootstrapState.needsIdentity();
    notifyListeners();
  }

  Future<String> checkBackendHealth() async {
    try {
      return await apiClient.healthStatus();
    } on DioException catch (error) {
      return 'network_error:${error.type.name}';
    } catch (error) {
      return 'error:$error';
    }
  }

  DeviceIdentity? get identity => _state.identity;

  Future<BackendStatus> _safeFetchBackendStatus() async {
    try {
      return await apiClient.fetchBackendStatus();
    } on DioException catch (error) {
      debugPrint('Backend probe failed: ${error.type.name}');
      return const BackendStatus.unknown();
    } catch (error) {
      debugPrint('Backend probe failed: $error');
      return const BackendStatus.unknown();
    }
  }
}
