CREATE TABLE application_process_cleanup (
  application_id BINARY(16) NOT NULL,
  node_id BINARY(16) NOT NULL,
  pm2_process_name VARCHAR(120) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (application_id, pm2_process_name),
  CONSTRAINT fk_process_cleanup_application
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_process_cleanup_node
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
