ALTER TABLE node_metrics
  ADD COLUMN network_received_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER disk_used_percent,
  ADD COLUMN network_sent_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER network_received_bytes;

ALTER TABLE pm2_process_snapshots
  ADD COLUMN storage_bytes BIGINT UNSIGNED NULL AFTER memory_bytes;

CREATE TABLE team_monitoring_settings (
  team_id BINARY(16) PRIMARY KEY,
  retention_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  node_offline_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  health_failure_threshold TINYINT UNSIGNED NOT NULL DEFAULT 3,
  notification_cooldown_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  panel_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  email_recipients JSON NULL,
  webhook_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  encrypted_webhook_url MEDIUMBLOB NULL,
  encrypted_webhook_secret MEDIUMBLOB NULL,
  notify_node_offline BOOLEAN NOT NULL DEFAULT TRUE,
  notify_application_down BOOLEAN NOT NULL DEFAULT TRUE,
  notify_resource_limit BOOLEAN NOT NULL DEFAULT TRUE,
  notify_recovery BOOLEAN NOT NULL DEFAULT TRUE,
  default_cpu_percent DECIMAL(6,2) NULL,
  default_memory_bytes BIGINT UNSIGNED NULL,
  default_storage_bytes BIGINT UNSIGNED NULL,
  default_traffic_bytes_monthly BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_monitoring_settings_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE application_health_checks (
  application_id BINARY(16) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  path VARCHAR(512) NOT NULL DEFAULT '/',
  interval_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  timeout_ms SMALLINT UNSIGNED NOT NULL DEFAULT 10000,
  expected_status_min SMALLINT UNSIGNED NOT NULL DEFAULT 200,
  expected_status_max SMALLINT UNSIGNED NOT NULL DEFAULT 399,
  consecutive_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('unknown','healthy','unhealthy') NOT NULL DEFAULT 'unknown',
  last_http_status SMALLINT UNSIGNED NULL,
  last_response_ms INT UNSIGNED NULL,
  last_error VARCHAR(1000) NULL,
  last_checked_at TIMESTAMP(3) NULL,
  next_check_at TIMESTAMP(3) NULL,
  status_changed_at TIMESTAMP(3) NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_health_check_due (enabled, next_check_at),
  CONSTRAINT fk_health_check_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE application_health_samples (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  application_id BINARY(16) NOT NULL,
  healthy BOOLEAN NOT NULL,
  http_status SMALLINT UNSIGNED NULL,
  response_ms INT UNSIGNED NULL,
  error_code VARCHAR(120) NULL,
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_health_sample_application_recorded (application_id, recorded_at),
  CONSTRAINT fk_health_sample_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE application_metrics (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  application_id BINARY(16) NOT NULL,
  node_id BINARY(16) NOT NULL,
  process_status VARCHAR(30) NOT NULL,
  cpu_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
  memory_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  storage_bytes BIGINT UNSIGNED NULL,
  traffic_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_application_metric_recorded (application_id, recorded_at),
  KEY ix_application_metric_node_recorded (node_id, recorded_at),
  CONSTRAINT fk_application_metric_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_application_metric_node FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE application_resource_limits (
  application_id BINARY(16) PRIMARY KEY,
  cpu_percent DECIMAL(6,2) NULL,
  memory_bytes BIGINT UNSIGNED NULL,
  storage_bytes BIGINT UNSIGNED NULL,
  traffic_bytes_monthly BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_resource_limit_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE monitoring_alerts (
  id BINARY(16) PRIMARY KEY,
  team_id BINARY(16) NOT NULL,
  resource_type ENUM('node','application') NOT NULL,
  resource_id BINARY(16) NOT NULL,
  alert_key VARCHAR(100) NOT NULL,
  event_type ENUM('node_offline','application_down','resource_limit') NOT NULL,
  severity ENUM('warning','error') NOT NULL DEFAULT 'warning',
  title VARCHAR(191) NOT NULL,
  message TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  occurrence_count INT UNSIGNED NOT NULL DEFAULT 1,
  first_triggered_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_notified_at TIMESTAMP(3) NULL,
  resolved_at TIMESTAMP(3) NULL,
  UNIQUE KEY uq_monitoring_alert_state (team_id, resource_type, resource_id, alert_key),
  KEY ix_monitoring_alert_active (team_id, active, last_seen_at),
  CONSTRAINT fk_monitoring_alert_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO team_monitoring_settings (team_id)
SELECT id FROM teams;

INSERT INTO application_health_checks (application_id, next_check_at)
SELECT id, CURRENT_TIMESTAMP(3) FROM applications WHERE deleted_at IS NULL;
