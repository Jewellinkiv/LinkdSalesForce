CREATE TABLE inbound_records (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('form','booking')),
 provider text NOT NULL, external_id text NOT NULL, brand text NOT NULL DEFAULT 'unknown',
 title text NOT NULL, name text NOT NULL, email text NOT NULL, phone text NOT NULL DEFAULT '',
 company_name text NOT NULL DEFAULT '', company_id uuid REFERENCES companies(id),
 retailer_id uuid REFERENCES retailers(id), prospect_id uuid REFERENCES prospects(id),
 owner_id uuid NOT NULL REFERENCES users(id), match_status text NOT NULL CHECK(match_status IN ('matched','unmatched','ambiguous','manual')),
 status text NOT NULL, review_status text NOT NULL DEFAULT 'new' CHECK(review_status IN ('new','reviewed','archived')),
 starts_at timestamptz, ends_at timestamptz, timezone text NOT NULL DEFAULT '',
 details jsonb NOT NULL DEFAULT '{}', notes text NOT NULL DEFAULT '', outcome text NOT NULL DEFAULT '',
 provider_updated_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,external_id), CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at>starts_at)
);
CREATE INDEX inbound_records_email ON inbound_records(lower(email));
CREATE INDEX inbound_records_company ON inbound_records(company_id);
CREATE INDEX inbound_records_retailer ON inbound_records(retailer_id);
CREATE INDEX inbound_records_prospect ON inbound_records(prospect_id);
CREATE INDEX inbound_records_schedule ON inbound_records(starts_at) WHERE kind='booking';
CREATE TABLE inbound_events (
 id uuid PRIMARY KEY, record_id uuid NOT NULL REFERENCES inbound_records(id),
 event_key text NOT NULL UNIQUE, title text NOT NULL, body text NOT NULL DEFAULT '',
 actor_id uuid REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_events_record ON inbound_events(record_id,occurred_at);
CREATE TABLE inbound_routing (
 brand text PRIMARY KEY CHECK(brand IN ('jewellink','linkd','jewelhire','countretail','unknown')),
 owner_id uuid REFERENCES users(id), notify_user_ids uuid[] NOT NULL DEFAULT '{}',
 booking_url text NOT NULL DEFAULT '', event_type_uris text[] NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1
);
INSERT INTO inbound_routing(brand,booking_url) VALUES
 ('jewellink','https://calendly.com/d/crr3-cgg-8cq/jewellink-demo-call'),
 ('linkd',''),('jewelhire',''),('countretail','https://calendly.com/d/crr3-cgg-8cq/jewellink-demo-call'),('unknown','');
