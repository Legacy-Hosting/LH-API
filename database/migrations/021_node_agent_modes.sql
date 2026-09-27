ALTER TABLE nodes
  ADD COLUMN agent_mode ENUM('hosting-node','monitor-only') NOT NULL DEFAULT 'hosting-node' AFTER region,
  ADD KEY ix_node_application_target (agent_mode, status, region, name);
