import '../../core/models/backend_status.dart';
import '../../core/models/device_identity.dart';
import '../../core/models/secure_session.dart';

enum BootstrapStatus { loading, needsIdentity, ready, failure }

class BootstrapState {
  const BootstrapState({
    required this.status,
    this.identity,
    this.session,
    this.backendStatus,
    this.errorMessage,
  });

  const BootstrapState.loading() : this(status: BootstrapStatus.loading);
  const BootstrapState.needsIdentity()
    : this(status: BootstrapStatus.needsIdentity);
  const BootstrapState.ready({
    required DeviceIdentity identity,
    SecureSession? session,
    BackendStatus backendStatus = const BackendStatus.unknown(),
  }) : this(
         status: BootstrapStatus.ready,
         identity: identity,
         session: session,
         backendStatus: backendStatus,
       );
  const BootstrapState.failure({required String errorMessage})
    : this(status: BootstrapStatus.failure, errorMessage: errorMessage);

  final BootstrapStatus status;
  final DeviceIdentity? identity;
  final SecureSession? session;
  final BackendStatus? backendStatus;
  final String? errorMessage;
}
