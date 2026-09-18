ALTER TABLE application_processes
  MODIFY COLUMN process_type ENUM('web','api','bot','worker','custom')
  NOT NULL DEFAULT 'worker';
