CREATE TABLE oidc_login_requests (
  state_hash BINARY(32) PRIMARY KEY,
  encrypted_code_verifier VARBINARY(512) NOT NULL,
  nonce VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  return_path VARCHAR(1024) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  consumed_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_oidc_login_request_cleanup (expires_at, consumed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
