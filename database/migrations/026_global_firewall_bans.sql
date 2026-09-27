CREATE TABLE global_firewall_bans (
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  address_family ENUM('ipv4','ipv6') NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  source_node_id BINARY(16) NULL,
  source_jail VARCHAR(80) NOT NULL DEFAULT 'sshd',
  reason VARCHAR(255) NOT NULL,
  activation_count INT UNSIGNED NOT NULL DEFAULT 1,
  first_reported_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_reported_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  removed_at TIMESTAMP(3) NULL,
  removed_by BINARY(16) NULL,
  removal_reason VARCHAR(255) NULL,
  suppressed_until TIMESTAMP(3) NULL,
  KEY ix_global_firewall_active_reported (active, last_reported_at),
  KEY ix_global_firewall_suppression (active, suppressed_until),
  CONSTRAINT fk_global_firewall_source_node FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE SET NULL,
  CONSTRAINT fk_global_firewall_removed_by FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO global_firewall_bans
  (ip_address,address_family,source_jail,reason)
VALUES
  ('95.85.245.227','ipv4','manual','Initial Legacy Hosting denylist'),
  ('45.148.10.141','ipv4','manual','Initial Legacy Hosting denylist'),
  ('193.47.62.69','ipv4','manual','Initial Legacy Hosting denylist'),
  ('37.120.162.199','ipv4','manual','Initial Legacy Hosting denylist');
