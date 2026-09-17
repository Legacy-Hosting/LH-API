CREATE TABLE agent_request_nonces (
  node_id BINARY(16) NOT NULL,
  nonce CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (node_id, nonce),
  KEY ix_agent_nonce_expiry (seen_at),
  CONSTRAINT fk_agent_nonce_node FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE user_sessions
  ADD KEY ix_session_cleanup (expires_at, revoked_at);
