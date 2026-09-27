ALTER TABLE applications
  DROP FOREIGN KEY fk_application_domain,
  MODIFY COLUMN domain_id BINARY(16) NULL,
  ADD CONSTRAINT fk_application_domain FOREIGN KEY (domain_id) REFERENCES domains(id);
