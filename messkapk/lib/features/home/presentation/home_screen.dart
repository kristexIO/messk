import 'package:flutter/material.dart';

import '../../bootstrap/bootstrap_controller.dart';
import '../../../features/bootstrap/bootstrap_scope.dart';
import '../../chat/presentation/chat_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String? _healthStatus;
  bool _isCheckingHealth = false;

  @override
  Widget build(BuildContext context) {
    final controller = BootstrapScope.of(context);
    final state = controller.state;
    final identity = state.identity!;
    final backendStatus = state.backendStatus;
    final session = state.session;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Messk Mobile')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(28),
              gradient: const LinearGradient(
                colors: [Color(0xFF0F172A), Color(0xFF115E59)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x22115E59),
                  blurRadius: 30,
                  offset: Offset(0, 14),
                ),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Secure mobile shell is ready',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 24,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  'Device identity is stored in secure storage. This project is isolated from the old web/desktop stack and is ready for native mobile iteration.',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.85),
                    fontSize: 15,
                    height: 1.35,
                  ),
                ),
                const SizedBox(height: 20),
                FilledButton.icon(
                  onPressed: () {
                    Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const ChatScreen()),
                    );
                  },
                  style: FilledButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: const Color(0xFF0F172A),
                  ),
                  icon: const Icon(Icons.chat_bubble_outline),
                  label: const Text('Open Global Chat'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          _InfoCard(
            title: 'Identity vault',
            icon: Icons.verified_user_outlined,
            lines: [
              'Device ID: ${identity.deviceId}',
              'Fingerprint: ${identity.shortFingerprint}',
              'Created: ${identity.createdAtUtc.toLocal()}',
            ],
          ),
          const SizedBox(height: 16),
          _InfoCard(
            title: 'Session vault',
            icon: Icons.lock_clock_outlined,
            lines: session == null
                ? const [
                    'No backend session stored yet.',
                    'Next step: wire native login/session bootstrap against messk.online.',
                  ]
                : [
                    'Token prefix: ${session.sessionToken.substring(0, 8)}...',
                    'Created: ${session.createdAtUtc.toLocal()}',
                    'Last used: ${session.lastUsedAtUtc.toLocal()}',
                  ],
          ),
          const SizedBox(height: 16),
          _InfoCard(
            title: 'Environment',
            icon: Icons.hub_outlined,
            lines: [
              'Env: ${controller.config.environment}',
              'API: ${controller.config.apiBaseUrl}',
              'WebSocket: ${controller.config.webSocketUrl}',
              if (controller.databaseService.databasePath case final path?)
                'DB: $path',
            ],
          ),
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        Icons.health_and_safety_outlined,
                        color: theme.colorScheme.primary,
                      ),
                      const SizedBox(width: 10),
                      Text(
                        'Backend health',
                        style: theme.textTheme.titleMedium,
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(
                    _healthStatus ??
                        'Health: ${backendStatus?.health ?? 'unknown'} | Version: ${backendStatus?.version ?? 'unknown'}',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Commit: ${backendStatus?.commit ?? 'unknown'} | Built: ${backendStatus?.builtAt ?? 'unknown'}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    onPressed: _isCheckingHealth
                        ? null
                        : () => _checkHealth(controller),
                    icon: _isCheckingHealth
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.wifi_tethering),
                    label: const Text('Probe /health'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          _InfoCard(
            title: 'Next build steps',
            icon: Icons.rocket_launch_outlined,
            lines: const [
              'Add Android SDK and Xcode toolchains for real device builds.',
              'Implement native login/session bootstrap against the production backend.',
              'Replace demo chat flow with encrypted direct/group messaging.',
              'Layer realtime sync, delivery states and background reconnect.',
            ],
          ),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: controller.wipeIdentity,
            icon: const Icon(Icons.delete_outline),
            label: const Text('Reset secure identity'),
          ),
        ],
      ),
    );
  }

  Future<void> _checkHealth(AppBootstrapController controller) async {
    setState(() => _isCheckingHealth = true);
    final status = await controller.checkBackendHealth();
    if (!mounted) {
      return;
    }
    setState(() {
      _healthStatus = status;
      _isCheckingHealth = false;
    });
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({
    required this.title,
    required this.icon,
    required this.lines,
  });

  final String title;
  final IconData icon;
  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, color: theme.colorScheme.primary),
                const SizedBox(width: 10),
                Text(title, style: theme.textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 14),
            for (final line in lines)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  line,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
