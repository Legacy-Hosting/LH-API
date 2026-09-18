ALTER TABLE node_commands
  MODIFY COLUMN command_type ENUM(
    'deploy',
    'start',
    'stop',
    'restart',
    'delete',
    'configure_proxy',
    'renew_certificate',
    'logs',
    'write_persistent_file'
  ) NOT NULL;
