CREATE TABLE products (
  id BINARY(16) PRIMARY KEY,
  product_key VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE users (
  id BINARY(16) PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  status ENUM('pending','active','suspended') NOT NULL DEFAULT 'pending',
  email_verified_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_passkeys (
  id BINARY(16) PRIMARY KEY,
  user_id BINARY(16) NOT NULL,
  credential_id VARBINARY(1024) NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
  transports JSON NULL,
  device_name VARCHAR(100) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at TIMESTAMP(3) NULL,
  CONSTRAINT fk_passkey_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE teams (
  id BINARY(16) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE team_members (
  team_id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  role ENUM('owner','administrator','developer','viewer') NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (team_id, user_id),
  CONSTRAINT fk_member_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE platform_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_by BINARY(16) NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_setting_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE nodes (
  id BINARY(16) PRIMARY KEY,
  team_id BINARY(16) NOT NULL,
  name VARCHAR(80) NOT NULL,
  public_ip VARCHAR(45) NOT NULL,
  private_ip VARCHAR(45) NULL,
  cname_target VARCHAR(253) NOT NULL,
  region VARCHAR(80) NULL,
  status ENUM('pending','online','offline','draining') NOT NULL DEFAULT 'pending',
  agent_version VARCHAR(30) NULL,
  last_heartbeat_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_node_team_name (team_id, name),
  CONSTRAINT fk_node_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integrations (
  id BINARY(16) PRIMARY KEY,
  team_id BINARY(16) NOT NULL,
  provider ENUM('github','cloudflare') NOT NULL,
  external_account_id VARCHAR(191) NOT NULL,
  display_name VARCHAR(191) NOT NULL,
  encrypted_credentials MEDIUMBLOB NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_integration_account (team_id, provider, external_account_id),
  CONSTRAINT fk_integration_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE domains (
  id BINARY(16) PRIMARY KEY,
  team_id BINARY(16) NOT NULL,
  integration_id BINARY(16) NULL,
  hostname VARCHAR(253) NOT NULL,
  root_domain VARCHAR(253) NOT NULL,
  record_type ENUM('A','AAAA','CNAME') NOT NULL DEFAULT 'CNAME',
  dns_target VARCHAR(253) NOT NULL,
  proxied BOOLEAN NOT NULL DEFAULT TRUE,
  status ENUM('pending','active','error') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_domain_hostname (hostname),
  CONSTRAINT fk_domain_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_domain_integration FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE applications (
  id BINARY(16) PRIMARY KEY,
  team_id BINARY(16) NOT NULL,
  node_id BINARY(16) NOT NULL,
  domain_id BINARY(16) NOT NULL,
  name VARCHAR(80) NOT NULL,
  storage_path VARCHAR(512) NOT NULL,
  pm2_process_name VARCHAR(120) NOT NULL,
  repository_full_name VARCHAR(255) NULL,
  repository_branch VARCHAR(255) NOT NULL DEFAULT 'main',
  auto_deploy BOOLEAN NOT NULL DEFAULT TRUE,
  detected_runtime JSON NULL,
  status ENUM('pending','deploying','running','stopped','failed') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_application_domain (domain_id),
  UNIQUE KEY uq_application_pm2_name (node_id, pm2_process_name),
  CONSTRAINT fk_application_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_application_node FOREIGN KEY (node_id) REFERENCES nodes(id),
  CONSTRAINT fk_application_domain FOREIGN KEY (domain_id) REFERENCES domains(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE application_environment_variables (
  id BINARY(16) PRIMARY KEY,
  application_id BINARY(16) NOT NULL,
  environment ENUM('development','staging','production') NOT NULL DEFAULT 'production',
  variable_key VARCHAR(191) NOT NULL,
  encrypted_value MEDIUMBLOB NOT NULL,
  is_secret BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_application_environment_key (application_id, environment, variable_key),
  CONSTRAINT fk_environment_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE deployments (
  id BINARY(16) PRIMARY KEY,
  application_id BINARY(16) NOT NULL,
  commit_sha CHAR(40) NULL,
  source ENUM('manual','github_push','rollback') NOT NULL,
  status ENUM('queued','building','deploying','succeeded','failed','rolled_back') NOT NULL DEFAULT 'queued',
  release_path VARCHAR(512) NULL,
  started_at TIMESTAMP(3) NULL,
  finished_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_deployment_application_created (application_id, created_at),
  CONSTRAINT fk_deployment_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE audit_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  team_id BINARY(16) NULL,
  user_id BINARY(16) NULL,
  product_key VARCHAR(50) NOT NULL,
  action VARCHAR(120) NOT NULL,
  resource_type VARCHAR(80) NULL,
  resource_id VARCHAR(191) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_audit_team_created (team_id, created_at),
  CONSTRAINT fk_audit_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO products (id, product_key, name) VALUES
  (UUID_TO_BIN(UUID()), 'panel', 'Legacy Hosting Panel'),
  (UUID_TO_BIN(UUID()), 'billing', 'Legacy Hosting Billing');

INSERT INTO platform_settings (setting_key, setting_value) VALUES
  ('registration', JSON_OBJECT('mode', 'closed', 'emailVerificationRequired', true));
