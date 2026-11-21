-- Platform infrastructure: quarantine lookup for signed URLs (platform-infra).
--
-- StorageService refuses to sign a URL for a stored object that is INFECTED or quarantined in any
-- row that points at it. The check runs before a URL is handed out, whatever the caller selected,
-- so no module can serve an infected file by accident. Returns a boolean only.
CREATE OR REPLACE FUNCTION ngao_storage_key_quarantined(p_storage_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM stored_files
    WHERE storage_key = p_storage_key
      AND (malware_scan_status = 'INFECTED' OR quarantined_at IS NOT NULL)
  )
$$;
REVOKE ALL ON FUNCTION ngao_storage_key_quarantined(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ngao_storage_key_quarantined(text) TO ngao_app;

CREATE INDEX IF NOT EXISTS "stored_files_storage_key_idx" ON "stored_files"("storage_key");
