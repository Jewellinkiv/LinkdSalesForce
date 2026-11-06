ALTER TABLE opportunities ADD COLUMN discount_type text NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount','percent'));
ALTER TABLE opportunities ADD COLUMN discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100);
ALTER TABLE companies ADD COLUMN profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE onboarding ADD COLUMN scope jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN in_progress boolean NOT NULL DEFAULT false;

CREATE TABLE customer_cadences (
 company_id uuid PRIMARY KEY REFERENCES companies(id), owner_id uuid NOT NULL REFERENCES users(id),
 interval_days integer NOT NULL DEFAULT 45 CHECK (interval_days BETWEEN 1 AND 365),
 next_at timestamptz NOT NULL, enabled boolean NOT NULL DEFAULT true, last_meeting_at timestamptz,
 last_contact_at timestamptz, notes text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1
);
CREATE TABLE recurring_touches (
 company_id uuid NOT NULL REFERENCES companies(id), scheduled_at timestamptz NOT NULL,
 task_id uuid NOT NULL UNIQUE REFERENCES tasks(id), PRIMARY KEY(company_id,scheduled_at)
);
CREATE TABLE prospects (
 id uuid PRIMARY KEY, request_key uuid NOT NULL UNIQUE, name text NOT NULL, contact_name text NOT NULL,
 email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', website text NOT NULL DEFAULT '',
 source text NOT NULL, notes text NOT NULL DEFAULT '', signals text NOT NULL DEFAULT '', fit_score numeric(4,1),
 status text NOT NULL DEFAULT 'research' CHECK(status IN ('research','review','approved','suppressed','converted')),
 owner_id uuid REFERENCES users(id), company_id uuid REFERENCES companies(id), opportunity_id uuid REFERENCES opportunities(id),
 review_notes text NOT NULL DEFAULT '', reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE TABLE public_requests (key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX public_requests_key ON public_requests(key,created_at);
CREATE TABLE sales_sequences (
 id uuid PRIMARY KEY, name text NOT NULL, steps jsonb NOT NULL,
 active boolean NOT NULL DEFAULT false, timezone text NOT NULL DEFAULT 'America/Chicago',
 start_hour integer NOT NULL DEFAULT 9 CHECK(start_hour BETWEEN 0 AND 22),
 end_hour integer NOT NULL DEFAULT 17 CHECK(end_hour BETWEEN 1 AND 23),
 weekdays_only boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES users(id),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), CHECK(end_hour>start_hour)
);
CREATE TABLE sequence_enrollments (
 id uuid PRIMARY KEY, sequence_id uuid NOT NULL REFERENCES sales_sequences(id),
 opportunity_id uuid NOT NULL REFERENCES opportunities(id), contact_id uuid NOT NULL REFERENCES contacts(id),
 owner_id uuid NOT NULL REFERENCES users(id), request_key uuid NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','stopped','completed','review')),
 delivery_mode text NOT NULL CHECK(delivery_mode IN ('demo','live')), snapshot jsonb NOT NULL,
 step_index integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
 reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sequence_unsubscribes (token_hash text PRIMARY KEY, contact_id uuid NOT NULL REFERENCES contacts(id));
CREATE UNIQUE INDEX one_active_sequence ON sequence_enrollments(contact_id) WHERE status IN ('active','paused','review');
CREATE TABLE sequence_steps (
 enrollment_id uuid NOT NULL REFERENCES sequence_enrollments(id), step_index integer NOT NULL,
 message_id uuid UNIQUE REFERENCES messages(id), task_id uuid UNIQUE REFERENCES tasks(id),
 completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(enrollment_id,step_index)
);
CREATE TABLE workflow_dependencies (
 id text PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','retained','replaced','retired')),
 owner_id uuid REFERENCES users(id), evidence text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workflow_dependencies(id,name) VALUES
 ('deal-webhook','Deal stage webhook'),('upgrade-webhook','Existing customer upgrade webhook'),
 ('customer-email','Customer status email rule'),('graduation','New-customer graduation destination'),
 ('billing','Billing and cutover timing'),('contracts','Contracts and signatures'),
 ('report-populations','Reporting population reconciliation'),('history','Historical email, files and project migration'),
 ('providers','Live voice, SMS, email and transcript acceptance');
CREATE TABLE record_files (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), user_id uuid REFERENCES users(id),
 name text NOT NULL, mime text NOT NULL, content bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
