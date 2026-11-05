-- Never release a demo queue into a live provider after a configuration change.
ALTER TABLE messages ADD COLUMN delivery_mode text NOT NULL DEFAULT 'demo'
  CHECK (delivery_mode IN ('demo', 'live'));
