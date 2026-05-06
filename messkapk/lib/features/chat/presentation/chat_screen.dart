import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/models/message.dart';
import '../../../core/repositories/chat_repository.dart';
import '../../bootstrap/bootstrap_scope.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  static const _peerId = ChatRepository.demoPeerId;

  final TextEditingController _messageController = TextEditingController();
  final List<Message> _messages = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadMessages();
  }

  Future<void> _loadMessages() async {
    final controller = BootstrapScope.of(context);
    final currentUserId = controller.identity!.deviceId;

    final messages = await controller.chatRepository.loadThread(
      peerId: _peerId,
      currentUserId: currentUserId,
    );
    setState(() {
      _messages.clear();
      _messages.addAll(messages);
      _isLoading = false;
    });
  }

  Future<void> _sendMessage() async {
    final text = _messageController.text.trim();
    if (text.isEmpty) return;

    final controller = BootstrapScope.of(context);
    final identity = controller.identity!;

    final message = Message(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      senderId: identity.deviceId,
      recipientId: _peerId,
      peerId: _peerId,
      content: text,
      timestamp: DateTime.now(),
      status: MessageStatus.sent,
      isMe: true,
    );

    await controller.chatRepository.saveOutgoingMessage(message);
    _messageController.clear();
    _loadMessages();

    Future.delayed(const Duration(seconds: 1), () async {
      final reply = Message(
        id: 'reply_${message.id}',
        senderId: _peerId,
        recipientId: identity.deviceId,
        peerId: _peerId,
        content: 'Secure room received: ${message.content}',
        timestamp: DateTime.now(),
        status: MessageStatus.delivered,
        isMe: false,
      );
      await controller.chatRepository.saveIncomingMessage(reply);
      if (mounted) {
        _loadMessages();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Secure Room', style: TextStyle(fontSize: 18)),
            Text(
              'Local encrypted demo thread',
              style: TextStyle(fontSize: 12, color: Colors.green),
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : _messages.isEmpty
                ? const Center(child: Text('No messages yet'))
                : ListView.builder(
                    reverse: true,
                    padding: const EdgeInsets.all(16),
                    itemCount: _messages.length,
                    itemBuilder: (context, index) {
                      final msg = _messages[index];
                      return _MessageBubble(message: msg);
                    },
                  ),
          ),
          _buildInput(),
        ],
      ),
    );
  }

  Widget _buildInput() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: BoxDecoration(
        color: Theme.of(context).cardColor,
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 10,
            offset: const Offset(0, -5),
          ),
        ],
      ),
      child: SafeArea(
        child: Row(
          children: [
            IconButton(
              icon: const Icon(Icons.add_circle_outline),
              onPressed: () {},
            ),
            Expanded(
              child: TextField(
                controller: _messageController,
                decoration: const InputDecoration(
                  hintText: 'Type a secure note...',
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.symmetric(horizontal: 12),
                ),
                onSubmitted: (_) => _sendMessage(),
              ),
            ),
            IconButton(
              icon: const Icon(Icons.send_rounded),
              color: Theme.of(context).colorScheme.primary,
              onPressed: _sendMessage,
            ),
          ],
        ),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message});
  final Message message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isMe = message.isMe;

    return Align(
      alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        decoration: BoxDecoration(
          color: isMe
              ? theme.colorScheme.primary
              : theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: Radius.circular(isMe ? 16 : 4),
            bottomRight: Radius.circular(isMe ? 4 : 16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              message.content,
              style: TextStyle(
                color: isMe
                    ? theme.colorScheme.onPrimary
                    : theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              DateFormat('HH:mm').format(message.timestamp),
              style: TextStyle(
                fontSize: 10,
                color:
                    (isMe
                            ? theme.colorScheme.onPrimary
                            : theme.colorScheme.onSurfaceVariant)
                        .withValues(alpha: 0.6),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
