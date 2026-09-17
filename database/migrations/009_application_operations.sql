ALTER TABLE node_commands
  MODIFY COLUMN command_type ENUM(
    'deploy',
    'start',
    'stop',
    'restart',
    'delete',
    'configure_proxy',
    'renew_certificate',
    'logs'
  ) NOT NULL;

ALTER TABLE deployments
  ADD COLUMN rollback_of_deployment_id BINARY(16) NULL AFTER application_id,
  ADD KEY ix_deployment_rollback_target (rollback_of_deployment_id),
  ADD CONSTRAINT fk_deployment_rollback_target
    FOREIGN KEY (rollback_of_deployment_id) REFERENCES deployments(id) ON DELETE SET NULL;
