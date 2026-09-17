ALTER TABLE node_commands
  MODIFY COLUMN command_type ENUM(
    'deploy',
    'start',
    'stop',
    'restart',
    'delete',
    'configure_proxy',
    'renew_certificate'
  ) NOT NULL;

ALTER TABLE domains
  ADD COLUMN proxy_status ENUM('pending','configuring','active','error') NOT NULL DEFAULT 'pending' AFTER status,
  ADD COLUMN certificate_renewed_at TIMESTAMP(3) NULL AFTER proxy_status,
  ADD COLUMN certificate_expires_at TIMESTAMP(3) NULL AFTER certificate_renewed_at,
  ADD KEY ix_domain_certificate_renewal (proxy_status, certificate_expires_at);
