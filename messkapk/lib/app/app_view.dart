import 'package:flutter/material.dart';

import '../features/bootstrap/bootstrap_scope.dart';
import '../features/bootstrap/bootstrap_state.dart';
import '../features/home/presentation/home_screen.dart';
import '../features/onboarding/presentation/onboarding_screen.dart';

class AppView extends StatelessWidget {
  const AppView({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = BootstrapScope.of(context);

    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        switch (controller.state.status) {
          case BootstrapStatus.loading:
            return const _SplashScreen();
          case BootstrapStatus.needsIdentity:
            return const OnboardingScreen();
          case BootstrapStatus.ready:
            return const HomeScreen();
          case BootstrapStatus.failure:
            return _FailureScreen(
              message:
                  controller.state.errorMessage ?? 'Unknown bootstrap error',
            );
        }
      },
    );
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 88,
              height: 88,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(28),
                gradient: const LinearGradient(
                  colors: [Color(0xFF14B8A6), Color(0xFF0F172A)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x3314B8A6),
                    blurRadius: 30,
                    offset: Offset(0, 12),
                  ),
                ],
              ),
              child: const Icon(
                Icons.lock_clock_outlined,
                color: Colors.white,
                size: 36,
              ),
            ),
            const SizedBox(height: 24),
            Text('Messk Mobile', style: theme.textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(
              'Preparing the secure device vault...',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 24),
            const CircularProgressIndicator(),
          ],
        ),
      ),
    );
  }
}

class _FailureScreen extends StatelessWidget {
  const _FailureScreen({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final controller = BootstrapScope.of(context);
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.error_outline,
                  size: 52,
                  color: theme.colorScheme.error,
                ),
                const SizedBox(height: 16),
                Text('Startup failed', style: theme.textTheme.headlineSmall),
                const SizedBox(height: 12),
                Text(
                  message,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 20),
                FilledButton.icon(
                  onPressed: controller.initialize,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Retry bootstrap'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
