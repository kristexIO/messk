import '../database/database_service.dart';
import '../models/device_identity.dart';
import '../models/message.dart';

class ChatRepository {
  ChatRepository({required DatabaseService databaseService})
    : _databaseService = databaseService;

  final DatabaseService _databaseService;

  static const demoPeerId = 'global-secure-room';

  Future<void> seedWelcomeThread(DeviceIdentity identity) async {
    final existing = await _databaseService.getMessagesForPeer(
      peerId: demoPeerId,
      currentUserId: identity.deviceId,
    );
    if (existing.isNotEmpty) {
      return;
    }

    final welcome = Message(
      id: 'welcome-${identity.deviceId}',
      senderId: demoPeerId,
      recipientId: identity.deviceId,
      peerId: demoPeerId,
      content:
          'Welcome to Messk Mobile. This native app is now running with secure local identity and encrypted storage foundations.',
      timestamp: DateTime.now().subtract(const Duration(minutes: 2)),
      status: MessageStatus.delivered,
      isMe: false,
    );
    await _databaseService.saveMessage(welcome);
  }

  Future<List<Message>> loadThread({
    required String peerId,
    required String currentUserId,
  }) {
    return _databaseService.getMessagesForPeer(
      peerId: peerId,
      currentUserId: currentUserId,
    );
  }

  Future<void> saveOutgoingMessage(Message message) {
    return _databaseService.saveMessage(message);
  }

  Future<void> saveIncomingMessage(Message message) {
    return _databaseService.saveMessage(message);
  }
}
