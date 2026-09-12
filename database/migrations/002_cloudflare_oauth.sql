ALTER TABLE integrations
  ADD COLUMN auth_method ENUM('oauth','api_token') NOT NULL DEFAULT 'oauth' AFTER provider,
  ADD COLUMN connection_scope ENUM('platform','customer') NOT NULL DEFAULT 'customer' AFTER auth_method,
  ADD COLUMN token_expires_at TIMESTAMP(3) NULL AFTER encrypted_credentials,
  ADD COLUMN disconnected_at TIMESTAMP(3) NULL AFTER token_expires_at;

CREATE TABLE oauth_authorization_states (
  id BINARY(16) PRIMARY KEY,
  team_id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  provider ENUM('cloudflare','github') NOT NULL,
  state_hash BINARY(32) NOT NULL UNIQUE,
  return_path VARCHAR(512) NOT NULL DEFAULT '/settings/integrations',
  expires_at TIMESTAMP(3) NOT NULL,
  consumed_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_oauth_state_expiry (expires_at),
  CONSTRAINT fk_oauth_state_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_oauth_state_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integration_resources (
  id BINARY(16) PRIMARY KEY,
  integration_id BINARY(16) NOT NULL,
  resource_type ENUM('account','zone') NOT NULL,
  external_resource_id VARCHAR(191) NOT NULL,
  display_name VARCHAR(253) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_integration_resource (integration_id, resource_type, external_resource_id),
  CONSTRAINT fk_resource_integration FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Legacy Hosting's own Cloudflare connection uses connection_scope='platform'.
-- Every customer connection uses connection_scope='customer' and belongs to its team_id.
