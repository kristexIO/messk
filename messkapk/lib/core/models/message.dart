enum MessageStatus { sending, sent, delivered, read, error }

class Message {
  const Message({
    required this.id,
    required this.senderId,
    required this.recipientId,
    required this.peerId,
    required this.content,
    required this.timestamp,
    required this.status,
    this.isMe = false,
  });

  final String id;
  final String senderId;
  final String recipientId;
  final String peerId;
  final String content;
  final DateTime timestamp;
  final MessageStatus status;
  final bool isMe;

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'sender_id': senderId,
      'recipient_id': recipientId,
      'peer_id': peerId,
      'content': content,
      'timestamp': timestamp.millisecondsSinceEpoch,
      'status': status.name,
    };
  }

  factory Message.fromMap(Map<String, dynamic> map, String currentUserId) {
    return Message(
      id: map['id'] as String,
      senderId: map['sender_id'] as String,
      recipientId: map['recipient_id'] as String,
      peerId: map['peer_id'] as String? ?? map['recipient_id'] as String,
      content: map['content'] as String,
      timestamp: DateTime.fromMillisecondsSinceEpoch(map['timestamp'] as int),
      status: MessageStatus.values.firstWhere((e) => e.name == map['status']),
      isMe: map['sender_id'] == currentUserId,
    );
  }
}
