ALTER TABLE pm2_process_snapshots
  ADD KEY ix_pm2_snapshot_node_process_recorded
    (node_id, process_name, recorded_at DESC);

ALTER TABLE applications
  ADD KEY ix_application_team_active_created
    (team_id, deleted_at, created_at DESC);

ALTER TABLE application_metrics
  ADD KEY ix_application_metric_traffic
    (application_id, recorded_at, traffic_bytes);
