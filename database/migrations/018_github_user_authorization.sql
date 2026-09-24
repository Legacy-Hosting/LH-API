CREATE TABLE github_user_connections (
  id BINARY(16) PRIMARY KEY,
  user_id BINARY(16) NOT NULL,
  github_user_id BIGINT UNSIGNED NOT NULL,
  github_login VARCHAR(191) NOT NULL,
  installation_id BIGINT UNSIGNED NOT NULL,
  encrypted_credentials MEDIUMBLOB NOT NULL,
  token_expires_at TIMESTAMP(3) NULL,
  refresh_token_expires_at TIMESTAMP(3) NULL,
  disconnected_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_github_connection_user (user_id),
  UNIQUE KEY uq_github_connection_identity (github_user_id),
  KEY ix_github_connection_installation (installation_id, disconnected_at),
  CONSTRAINT fk_github_connection_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE github_user_repository_access (
  connection_id BINARY(16) NOT NULL,
  integration_id BINARY(16) NOT NULL,
  repository_id VARCHAR(191) NOT NULL,
  permissions JSON NULL,
  verified_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (connection_id, integration_id, repository_id),
  KEY ix_github_user_repository_integration (integration_id, repository_id),
  CONSTRAINT fk_github_user_repository_connection FOREIGN KEY (connection_id)
    REFERENCES github_user_connections(id) ON DELETE CASCADE,
  CONSTRAINT fk_github_user_repository_integration FOREIGN KEY (integration_id)
    REFERENCES integrations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
