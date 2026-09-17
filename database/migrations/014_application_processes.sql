CREATE TABLE application_processes (
  id BINARY(16) PRIMARY KEY,
  application_id BINARY(16) NOT NULL,
  node_id BINARY(16) NOT NULL,
  domain_id BINARY(16) NULL,
  name VARCHAR(80) NOT NULL,
  pm2_process_name VARCHAR(120) NOT NULL,
  process_type ENUM('web','api','worker','custom') NOT NULL DEFAULT 'worker',
  working_directory VARCHAR(512) NOT NULL DEFAULT '.',
  executable VARCHAR(255) NOT NULL,
  arguments JSON NOT NULL,
  internal_port SMALLINT UNSIGNED NULL,
  host_variable VARCHAR(191) NULL,
  port_variable VARCHAR(191) NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  routes JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  start_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  instances SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  restart_delay_ms INT UNSIGNED NOT NULL DEFAULT 1000,
  inherit_environment BOOLEAN NOT NULL DEFAULT TRUE,
  health_path VARCHAR(512) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_application_process_name (application_id, name),
  UNIQUE KEY uq_process_node_pm2_name (node_id, pm2_process_name),
  UNIQUE KEY uq_process_node_port (node_id, internal_port),
  CONSTRAINT fk_process_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_process_node FOREIGN KEY (node_id) REFERENCES nodes(id),
  CONSTRAINT fk_process_domain FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO application_processes
  (id,application_id,node_id,domain_id,name,pm2_process_name,process_type,
   working_directory,executable,arguments,internal_port,is_primary,is_public,routes,
   enabled,start_order,instances,restart_delay_ms,inherit_environment,health_path,
   host_variable,port_variable)
SELECT UUID_TO_BIN(UUID()),a.id,a.node_id,a.domain_id,'web',a.pm2_process_name,'web','.',
       COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.detected_runtime,'$.start.command')),'npm'),
       COALESCE(JSON_EXTRACT(a.detected_runtime,'$.start.args'),JSON_ARRAY('start')),
       a.internal_port,TRUE,TRUE,JSON_ARRAY('/'),TRUE,0,1,1000,TRUE,'/health',NULL,NULL
FROM applications a
WHERE a.deleted_at IS NULL;

CREATE TABLE application_domains (
  application_id BINARY(16) NOT NULL,
  domain_id BINARY(16) NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  routing_mode ENUM('shared','dedicated') NOT NULL DEFAULT 'shared',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (application_id, domain_id),
  CONSTRAINT fk_application_domain_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_application_domain_domain FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO application_domains (application_id,domain_id,is_primary,routing_mode)
SELECT id,domain_id,TRUE,'shared' FROM applications;

CREATE TABLE application_persistent_paths (
  id BINARY(16) PRIMARY KEY,
  application_id BINARY(16) NOT NULL,
  relative_path VARCHAR(512) NOT NULL,
  path_type ENUM('file','directory') NOT NULL DEFAULT 'directory',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_application_persistent_path (application_id, relative_path),
  CONSTRAINT fk_persistent_path_application FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE application_environment_variables
  ADD COLUMN process_name VARCHAR(80) NOT NULL DEFAULT '*' AFTER environment,
  DROP INDEX uq_application_environment_key,
  ADD UNIQUE KEY uq_application_environment_process_key
    (application_id, environment, process_name, variable_key);
