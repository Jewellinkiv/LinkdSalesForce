ALTER TABLE notifications ADD COLUMN email_status text;
ALTER TABLE notifications ADD COLUMN email_provider_id text;
ALTER TABLE notifications ADD COLUMN email_recipient text;
ALTER TABLE notifications ADD COLUMN email_mode text CHECK(email_mode IN ('demo','live'));
