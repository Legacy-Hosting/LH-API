ALTER TABLE applications
  DROP FOREIGN KEY fk_application_domain;

ALTER TABLE applications
  MODIFY COLUMN domain_id BINARY(16) NULL;

ALTER TABLE applications
  ADD CONSTRAINT fk_application_domain FOREIGN KEY (domain_id) REFERENCES domains(id);
