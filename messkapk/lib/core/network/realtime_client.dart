import 'package:web_socket_channel/web_socket_channel.dart';

import '../config/app_config.dart';

class RealtimeClient {
  RealtimeClient({required AppConfig config})
    : _endpoint = Uri.parse(config.webSocketUrl);

  final Uri _endpoint;

  WebSocketChannel connect() {
    return WebSocketChannel.connect(_endpoint);
  }
}
