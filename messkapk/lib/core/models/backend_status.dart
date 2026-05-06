class BackendStatus {
  const BackendStatus({
    required this.health,
    required this.version,
    required this.commit,
    required this.builtAt,
  });

  const BackendStatus.unknown()
    : health = 'unknown',
      version = 'unknown',
      commit = 'unknown',
      builtAt = 'unknown';

  final String health;
  final String version;
  final String commit;
  final String builtAt;
}
