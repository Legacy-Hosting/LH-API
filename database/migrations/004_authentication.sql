ALTER TABLE users
  ADD COLUMN is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE AFTER status;

ALTER TABLE user_passkeys
  MODIFY COLUMN credential_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ADD COLUMN webauthn_user_id VARBINARY(64) NOT NULL AFTER user_id,
  ADD COLUMN device_type ENUM('singleDevice','multiDevice') NULL AFTER counter,
  ADD COLUMN backed_up BOOLEAN NOT NULL DEFAULT FALSE AFTER device_type;

CREATE TABLE auth_challenges (
  id BINARY(16) PRIMARY KEY,
  user_id BINARY(16) NULL,
  ceremony ENUM('registration','authentication') NOT NULL,
  challenge VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  context JSON NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  consumed_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_auth_challenge_expiry (expires_at),
  CONSTRAINT fk_auth_challenge_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_sessions (
  id BINARY(16) PRIMARY KEY,
  user_id BINARY(16) NOT NULL,
  token_hash BINARY(32) NOT NULL UNIQUE,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(512) NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_session_user (user_id, expires_at),
  KEY ix_session_expiry (expires_at),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE invitations (
  id BINARY(16) PRIMARY KEY,
  team_id BINARY(16) NOT NULL,
  email VARCHAR(254) NOT NULL,
  role ENUM('owner','administrator','developer','viewer') NOT NULL DEFAULT 'viewer',
  token_hash BINARY(32) NOT NULL UNIQUE,
  invited_by BINARY(16) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  accepted_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_invitation_email (email, expires_at),
  CONSTRAINT fk_invitation_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_invitation_user FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Existing installations retain their registration setting from 001_platform.sql.
-- The first user must bootstrap with INITIAL_ADMIN_TOKEN even when registration is closed.
