import 'package:flutter/widgets.dart';

import 'bootstrap_controller.dart';

class BootstrapScope extends InheritedWidget {
  const BootstrapScope({
    required this.controller,
    required super.child,
    super.key,
  });

  final AppBootstrapController controller;

  static AppBootstrapController of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<BootstrapScope>();
    assert(scope != null, 'BootstrapScope is missing in widget tree');
    return scope!.controller;
  }

  @override
  bool updateShouldNotify(BootstrapScope oldWidget) =>
      oldWidget.controller != controller;
}
