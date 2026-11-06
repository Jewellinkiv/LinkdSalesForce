CREATE TABLE retailers (
 id uuid PRIMARY KEY, identity_key text NOT NULL UNIQUE, name text NOT NULL,
 city text NOT NULL DEFAULT '', state text NOT NULL DEFAULT '', country text NOT NULL DEFAULT '',
 address text NOT NULL DEFAULT '', postal text NOT NULL DEFAULT '', website text NOT NULL DEFAULT '',
 company_id uuid REFERENCES companies(id), prospect_id uuid UNIQUE REFERENCES prospects(id),
 client_status text NOT NULL DEFAULT 'unverified' CHECK(client_status IN ('unverified','current','not_current')),
 client_evidence text NOT NULL DEFAULT '', owner_id uuid NOT NULL REFERENCES users(id),
 outreach_status text NOT NULL DEFAULT 'not_started' CHECK(outreach_status IN ('not_started','contacted','replied','meeting_booked','nurture','do_not_contact')),
 next_action text NOT NULL DEFAULT '', next_at timestamptz, tags text[] NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE retailer_imports (
 id uuid PRIMARY KEY, fingerprint text NOT NULL, filename text NOT NULL, sheet text NOT NULL,
 group_name text NOT NULL, list_name text NOT NULL, rows jsonb NOT NULL, summary jsonb,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz
);
CREATE UNIQUE INDEX retailer_import_applied ON retailer_imports(fingerprint) WHERE applied_at IS NOT NULL;
CREATE TABLE retailer_sources (
 id uuid PRIMARY KEY, retailer_id uuid NOT NULL REFERENCES retailers(id), import_id uuid NOT NULL REFERENCES retailer_imports(id),
 group_name text NOT NULL, list_name text NOT NULL, source_row integer NOT NULL, raw jsonb NOT NULL,
 UNIQUE(import_id,source_row)
);
CREATE INDEX retailer_source_group ON retailer_sources(group_name,retailer_id);
CREATE INDEX retailer_sources_retailer ON retailer_sources(retailer_id);
CREATE TABLE retailer_people (
 id uuid PRIMARY KEY, retailer_id uuid NOT NULL REFERENCES retailers(id), name text NOT NULL DEFAULT '',
 title text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
 source_key text, version integer NOT NULL DEFAULT 1, UNIQUE(retailer_id,source_key)
);
CREATE TABLE retailer_events (
 id uuid PRIMARY KEY, retailer_id uuid NOT NULL REFERENCES retailers(id), user_id uuid NOT NULL REFERENCES users(id),
 request_key uuid NOT NULL UNIQUE, kind text NOT NULL, body text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE retailer_photos (
 id uuid PRIMARY KEY, retailer_id uuid NOT NULL REFERENCES retailers(id), person_id uuid REFERENCES retailer_people(id),
 user_id uuid NOT NULL REFERENCES users(id), request_key uuid NOT NULL UNIQUE,
 caption text NOT NULL, mime text NOT NULL, content bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retailer_photos_retailer ON retailer_photos(retailer_id,created_at DESC);
CREATE INDEX retailer_events_history ON retailer_events(retailer_id,occurred_at DESC);
