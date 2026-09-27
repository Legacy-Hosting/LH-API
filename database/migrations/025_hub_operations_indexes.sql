ALTER TABLE deployments
  ADD KEY ix_deployment_created_status (created_at DESC, status);

ALTER TABLE applications
  ADD KEY ix_application_active_status (deleted_at, status);

ALTER TABLE nodes
  ADD KEY ix_node_status_heartbeat (status, last_heartbeat_at DESC);
