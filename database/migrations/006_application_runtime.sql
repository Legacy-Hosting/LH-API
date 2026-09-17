ALTER TABLE applications
  ADD COLUMN internal_port SMALLINT UNSIGNED NULL AFTER pm2_process_name,
  ADD COLUMN deleted_at TIMESTAMP(3) NULL AFTER updated_at,
  MODIFY COLUMN status ENUM('pending','deploying','running','stopped','failed','deleting','deleted') NOT NULL DEFAULT 'pending',
  ADD UNIQUE KEY uq_application_node_port (node_id, internal_port);
