import 'package:flutter/material.dart';

import '../features/bootstrap/bootstrap_controller.dart';
import '../features/bootstrap/bootstrap_scope.dart';
import 'app_view.dart';
import 'theme/app_theme.dart';

class MesskMobileApp extends StatelessWidget {
  const MesskMobileApp({required this.controller, super.key});

  final AppBootstrapController controller;

  @override
  Widget build(BuildContext context) {
    return BootstrapScope(
      controller: controller,
      child: MaterialApp(
        title: 'Messk Mobile',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        darkTheme: AppTheme.dark(),
        themeMode: ThemeMode.system,
        home: const AppView(),
      ),
    );
  }
}
