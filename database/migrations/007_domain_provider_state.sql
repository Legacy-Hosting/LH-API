ALTER TABLE domains
  ADD COLUMN provider_record_id VARCHAR(191) NULL AFTER dns_target,
  ADD COLUMN last_error TEXT NULL AFTER status;
