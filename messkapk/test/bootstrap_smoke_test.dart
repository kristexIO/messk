import 'package:flutter_test/flutter_test.dart';
import 'package:messkapk/core/config/app_config.dart';

void main() {
  test('default config targets messk.online', () {
    final config = AppConfig.fromEnvironment();

    expect(config.apiBaseUrl, 'https://messk.online');
    expect(config.webSocketUrl, 'wss://messk.online/ws');
  });
}
