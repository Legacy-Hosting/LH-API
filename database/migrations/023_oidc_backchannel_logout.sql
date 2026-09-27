CREATE TABLE oidc_logout_events (
  jti_hash BINARY(32) PRIMARY KEY,
  subject BINARY(16) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_oidc_logout_event_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
