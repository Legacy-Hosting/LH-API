CREATE TABLE application_monitoring_webhooks (
  application_id BINARY(16) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  encrypted_webhook_url MEDIUMBLOB NULL,
  encrypted_webhook_secret MEDIUMBLOB NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_monitoring_webhook_application
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO application_monitoring_webhooks
  (application_id,enabled,encrypted_webhook_url,encrypted_webhook_secret)
SELECT a.id,s.webhook_enabled,s.encrypted_webhook_url,s.encrypted_webhook_secret
FROM applications a
JOIN team_monitoring_settings s ON s.team_id=a.team_id
WHERE a.deleted_at IS NULL
  AND (s.webhook_enabled=TRUE OR s.encrypted_webhook_url IS NOT NULL OR s.encrypted_webhook_secret IS NOT NULL);
