class AppConfig {
  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.webSocketUrl,
  });

  factory AppConfig.fromEnvironment() {
    const apiBaseUrl = String.fromEnvironment(
      'MESSK_API_BASE',
      defaultValue: 'https://messk.online',
    );
    const environment = String.fromEnvironment(
      'MESSK_ENV',
      defaultValue: 'production',
    );

    return AppConfig(
      environment: environment,
      apiBaseUrl: apiBaseUrl,
      webSocketUrl: _toWebSocketUrl(apiBaseUrl),
    );
  }

  final String environment;
  final String apiBaseUrl;
  final String webSocketUrl;

  static String _toWebSocketUrl(String apiBaseUrl) {
    final uri = Uri.parse(apiBaseUrl);
    final secure = uri.scheme == 'https';
    return uri
        .replace(
          scheme: secure ? 'wss' : 'ws',
          path: '/ws',
          query: null,
          fragment: null,
        )
        .toString();
  }
}
