import 'package:flutter/widgets.dart';

import 'app/app.dart';
import 'core/config/app_config.dart';
import 'core/database/database_service.dart';
import 'core/network/api_client.dart';
import 'core/network/realtime_client.dart';
import 'core/repositories/chat_repository.dart';
import 'core/security/identity_vault_service.dart';
import 'core/security/session_vault_service.dart';
import 'core/security/secure_storage_service.dart';
import 'features/bootstrap/bootstrap_controller.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final config = AppConfig.fromEnvironment();
  final secureStorage = SecureStorageService();
  final identityVault = IdentityVaultService(secureStorage: secureStorage);
  final sessionVault = SessionVaultService(secureStorage: secureStorage);
  final apiClient = ApiClient(config: config);
  final realtimeClient = RealtimeClient(config: config);
  final databaseService = DatabaseService();
  final chatRepository = ChatRepository(databaseService: databaseService);

  final controller = AppBootstrapController(
    config: config,
    secureStorage: secureStorage,
    identityVault: identityVault,
    apiClient: apiClient,
    realtimeClient: realtimeClient,
    databaseService: databaseService,
    sessionVault: sessionVault,
    chatRepository: chatRepository,
  );

  await controller.initialize();
  runApp(MesskMobileApp(controller: controller));
}
