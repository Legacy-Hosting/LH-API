ALTER TABLE audit_events
  ADD KEY ix_audit_created (created_at, id);
