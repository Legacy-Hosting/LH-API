ALTER TABLE nodes
  ADD COLUMN public_fqdn VARCHAR(253) NULL AFTER name,
  ADD COLUMN public_ipv6 VARCHAR(45) NULL AFTER public_ip,
  ADD COLUMN private_fqdn VARCHAR(253) NULL AFTER public_ipv6,
  ADD COLUMN private_ipv6 VARCHAR(45) NULL AFTER private_ip,
  MODIFY public_ip VARCHAR(45) NULL;

UPDATE nodes
SET public_fqdn=cname_target
WHERE public_fqdn IS NULL;

ALTER TABLE nodes
  MODIFY public_fqdn VARCHAR(253) NOT NULL;
