CREATE TABLE node_agent_credentials (
  node_id BINARY(16) PRIMARY KEY,
  authentication_key BINARY(32) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at TIMESTAMP(3) NULL,
  revoked_at TIMESTAMP(3) NULL,
  CONSTRAINT fk_agent_credential_node FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE node_metrics (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  node_id BINARY(16) NOT NULL,
  load_1 DECIMAL(8,3) NOT NULL,
  load_5 DECIMAL(8,3) NOT NULL,
  load_15 DECIMAL(8,3) NOT NULL,
  memory_total_bytes BIGINT UNSIGNED NOT NULL,
  memory_used_bytes BIGINT UNSIGNED NOT NULL,
  memory_used_percent DECIMAL(5,2) NOT NULL,
  disk_used_percent DECIMAL(5,2) NULL,
  uptime_seconds BIGINT UNSIGNED NOT NULL,
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_node_metrics_node_recorded (node_id, recorded_at),
  CONSTRAINT fk_metric_node FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pm2_process_snapshots (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  node_id BINARY(16) NOT NULL,
  pm2_id INT NULL,
  process_name VARCHAR(120) NOT NULL,
  process_status VARCHAR(30) NOT NULL,
  pid INT NULL,
  cpu_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
  memory_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  restart_count INT UNSIGNED NOT NULL DEFAULT 0,
  started_at TIMESTAMP(3) NULL,
  revision VARCHAR(64) NULL,
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_pm2_snapshot_node_recorded (node_id, recorded_at),
  CONSTRAINT fk_pm2_snapshot_node FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
