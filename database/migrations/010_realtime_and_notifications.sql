ALTER TABLE node_commands
  ADD COLUMN deployment_id BINARY(16) NULL AFTER application_id,
  ADD COLUMN cancel_requested_at TIMESTAMP(3) NULL AFTER lease_expires_at;

UPDATE node_commands
SET deployment_id=UUID_TO_BIN(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.deploymentId')))
WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.deploymentId')) REGEXP
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

ALTER TABLE node_commands
  ADD UNIQUE KEY uq_node_command_deployment (deployment_id),
  ADD CONSTRAINT fk_command_deployment
    FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE SET NULL;

ALTER TABLE deployments
  MODIFY COLUMN status ENUM(
    'queued',
    'building',
    'deploying',
    'succeeded',
    'failed',
    'rolled_back',
    'cancelled'
  ) NOT NULL DEFAULT 'queued';

CREATE TABLE notifications (
  id BINARY(16) PRIMARY KEY,
  team_id BINARY(16) NOT NULL,
  notification_type VARCHAR(80) NOT NULL,
  severity ENUM('info','warning','error') NOT NULL DEFAULT 'info',
  title VARCHAR(191) NOT NULL,
  message TEXT NOT NULL,
  resource_type VARCHAR(80) NULL,
  resource_id VARCHAR(191) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_notification_team_created (team_id, created_at),
  CONSTRAINT fk_notification_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE notification_reads (
  notification_id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  read_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (notification_id, user_id),
  CONSTRAINT fk_notification_read_notification
    FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  CONSTRAINT fk_notification_read_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
