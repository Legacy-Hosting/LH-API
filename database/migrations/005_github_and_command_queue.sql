ALTER TABLE integration_resources
  MODIFY COLUMN resource_type ENUM('account','zone','repository') NOT NULL;

CREATE TABLE github_webhook_deliveries (
  delivery_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  event_name VARCHAR(80) NOT NULL,
  action_name VARCHAR(80) NULL,
  installation_id BIGINT UNSIGNED NULL,
  payload JSON NOT NULL,
  processed_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_github_delivery_installation (installation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE node_commands (
  id BINARY(16) PRIMARY KEY,
  node_id BINARY(16) NOT NULL,
  application_id BINARY(16) NULL,
  command_type ENUM('deploy','start','stop','restart','delete') NOT NULL,
  payload JSON NOT NULL,
  status ENUM('queued','leased','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued',
  lease_token_hash BINARY(32) NULL,
  lease_expires_at TIMESTAMP(3) NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  output MEDIUMTEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at TIMESTAMP(3) NULL,
  finished_at TIMESTAMP(3) NULL,
  KEY ix_node_command_claim (node_id, status, created_at),
  CONSTRAINT fk_command_node FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_command_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
