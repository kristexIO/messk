import 'package:flutter/material.dart';

import '../../bootstrap/bootstrap_controller.dart';
import '../../../features/bootstrap/bootstrap_scope.dart';

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  bool _isCreating = false;

  @override
  Widget build(BuildContext context) {
    final controller = BootstrapScope.of(context);
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Spacer(),
              Container(
                width: 96,
                height: 96,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(28),
                  gradient: const LinearGradient(
                    colors: [Color(0xFF14B8A6), Color(0xFF0F172A)],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                ),
                child: const Icon(
                  Icons.security_outlined,
                  color: Colors.white,
                  size: 42,
                ),
              ),
              const SizedBox(height: 28),
              Text(
                'New secure mobile client',
                style: theme.textTheme.headlineMedium,
              ),
              const SizedBox(height: 16),
              Text(
                'This app starts from a clean native foundation. The first step is generating a device identity and storing it in the platform secure vault.',
                style: theme.textTheme.bodyLarge?.copyWith(
                  height: 1.4,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 20),
              const _ChecklistItem(
                text: 'Separate mobile codebase, no Tauri dependency',
              ),
              const _ChecklistItem(
                text: 'Secure storage enabled for Android and iPhone',
              ),
              const _ChecklistItem(
                text: 'Backend and websocket endpoints preconfigured',
              ),
              const _ChecklistItem(
                text: 'Ready for encrypted local database and realtime sync',
              ),
              const Spacer(),
              FilledButton.icon(
                onPressed: _isCreating
                    ? null
                    : () => _createIdentity(controller),
                icon: _isCreating
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.lock_open_outlined),
                label: const Text('Create secure identity'),
              ),
              const SizedBox(height: 12),
              Text(
                'Server target: https://messk.online',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _createIdentity(AppBootstrapController controller) async {
    setState(() => _isCreating = true);
    await controller.createIdentity();
    if (!mounted) {
      return;
    }
    setState(() => _isCreating = false);
  }
}

class _ChecklistItem extends StatelessWidget {
  const _ChecklistItem({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(
              Icons.check_circle_outline,
              size: 20,
              color: theme.colorScheme.primary,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
