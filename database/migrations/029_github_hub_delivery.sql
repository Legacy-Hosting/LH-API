ALTER TABLE github_webhook_deliveries
  ADD COLUMN hub_forwarded_at TIMESTAMP(3) NULL AFTER processed_at,
  ADD KEY ix_github_hub_forwarding (event_name, hub_forwarded_at, created_at);
