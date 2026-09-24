CREATE TABLE github_user_installations (
  connection_id BINARY(16) NOT NULL,
  integration_id BINARY(16) NOT NULL,
  installation_id BIGINT UNSIGNED NOT NULL,
  account_login VARCHAR(191) NOT NULL,
  account_type VARCHAR(32) NOT NULL,
  repository_selection ENUM('all','selected') NOT NULL,
  permissions JSON NULL,
  verified_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (connection_id, integration_id),
  KEY ix_github_user_installation (connection_id, installation_id),
  CONSTRAINT fk_github_user_installation_connection FOREIGN KEY (connection_id)
    REFERENCES github_user_connections(id) ON DELETE CASCADE,
  CONSTRAINT fk_github_user_installation_integration FOREIGN KEY (integration_id)
    REFERENCES integrations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO github_user_installations
  (connection_id,integration_id,installation_id,account_login,account_type,
   repository_selection,permissions)
SELECT DISTINCT c.id,i.id,c.installation_id,i.display_name,
  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(i.metadata,'$.accountType')),'Organization'),
  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(i.metadata,'$.repositorySelection')),'all'),
  JSON_EXTRACT(i.metadata,'$.permissions')
FROM github_user_connections c
JOIN github_user_repository_access a ON a.connection_id=c.id
JOIN integrations i ON i.id=a.integration_id AND i.provider='github';
