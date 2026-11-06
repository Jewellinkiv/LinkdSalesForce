ALTER TABLE companies ADD COLUMN lifecycle text NOT NULL DEFAULT 'prospect' CHECK (lifecycle IN ('prospect','onboarding','active','paused','churned'));
ALTER TABLE companies ADD COLUMN do_not_contact boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN restriction_reason text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE contacts ADD COLUMN do_not_contact boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN restriction_reason text NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE opportunities DROP CONSTRAINT opportunities_stage_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_stage_check CHECK (stage IN ('New lead','Contacted','Qualified','Demo scheduled','Need next meeting','Decision','Won','Lost','Be back'));
ALTER TABLE opportunities DROP CONSTRAINT opportunities_package_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_package_check CHECK (package IN ('Undecided','Full suite','Training only','Data & training','Texting'));
ALTER TABLE opportunities ADD COLUMN kind text NOT NULL DEFAULT 'lead' CHECK (kind IN ('lead','deal'));
ALTER TABLE opportunities ADD COLUMN source_lead_id uuid UNIQUE REFERENCES opportunities(id);
ALTER TABLE opportunities ADD COLUMN qualified_at timestamptz;
ALTER TABLE opportunities ADD COLUMN appointment_at timestamptz;
ALTER TABLE opportunities ADD COLUMN closed_at timestamptz;
ALTER TABLE opportunities ADD COLUMN effective_date date;
ALTER TABLE opportunities ADD COLUMN discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0);
ALTER TABLE opportunities ADD COLUMN version integer NOT NULL DEFAULT 1;
UPDATE opportunities SET kind='deal' WHERE stage IN ('Demo scheduled','Decision','Won');
UPDATE opportunities SET closed_at=won_at,effective_date=won_at::date WHERE stage='Won';
UPDATE companies c SET lifecycle='onboarding' WHERE EXISTS (SELECT 1 FROM onboarding p WHERE p.company_id=c.id);
UPDATE companies c SET lifecycle='active' WHERE EXISTS (SELECT 1 FROM onboarding p WHERE p.company_id=c.id AND p.phase='Onboarded');
ALTER TABLE tasks ADD COLUMN resolution text NOT NULL DEFAULT 'open' CHECK (resolution IN ('open','completed','superseded','cancelled'));
ALTER TABLE tasks ADD COLUMN resolved_at timestamptz;
UPDATE tasks SET resolution='completed',resolved_at=completed_at WHERE completed_at IS NOT NULL;
ALTER TABLE onboarding ALTER COLUMN opportunity_id DROP NOT NULL;
ALTER TABLE onboarding ADD COLUMN package text NOT NULL DEFAULT 'Full suite';
UPDATE onboarding p SET package=o.package FROM opportunities o WHERE o.id=p.opportunity_id;
ALTER TABLE onboarding ADD COLUMN source text NOT NULL DEFAULT 'new_sale' CHECK (source IN ('new_sale','existing_customer'));
ALTER TABLE onboarding ADD COLUMN cs_owner_id uuid REFERENCES users(id);
ALTER TABLE onboarding ADD COLUMN sales_owner_id uuid REFERENCES users(id);
UPDATE onboarding p SET cs_owner_id=p.owner_id,sales_owner_id=o.owner_id FROM opportunities o WHERE o.id=p.opportunity_id;
ALTER TABLE onboarding ADD COLUMN go_live_at date;
ALTER TABLE onboarding ADD COLUMN billing_at date;
ALTER TABLE onboarding ADD COLUMN intake_received_at timestamptz;
ALTER TABLE onboarding ADD COLUMN readiness jsonb NOT NULL DEFAULT '{}';
ALTER TABLE onboarding ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE TABLE notifications (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), company_id uuid REFERENCES companies(id),
 title text NOT NULL, body text NOT NULL DEFAULT '', dedupe_key text NOT NULL UNIQUE,
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id,created_at DESC);
CREATE TABLE intake_links (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES onboarding(id), token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE intake_submissions (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES onboarding(id), request_key uuid NOT NULL UNIQUE,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE intake_files (
 id uuid PRIMARY KEY, submission_id uuid NOT NULL REFERENCES intake_submissions(id),
 name text NOT NULL, mime text NOT NULL, content bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE settings (key text PRIMARY KEY,value jsonb NOT NULL);
INSERT INTO settings VALUES ('automation', '{"welcome":false,"intakeNudge":false,"schedulingUrl":""}');
CREATE TABLE invitations (
 id uuid PRIMARY KEY, email text NOT NULL, name text NOT NULL, role text NOT NULL CHECK (role IN ('admin','sales','onboarding')),
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;
CREATE TABLE import_runs (id uuid PRIMARY KEY,source text NOT NULL,summary jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE external_records (source text NOT NULL,external_id text NOT NULL,company_id uuid NOT NULL REFERENCES companies(id),PRIMARY KEY(source,external_id));
ALTER TABLE tasks ADD COLUMN is_next_action boolean NOT NULL DEFAULT false;
UPDATE tasks SET is_next_action=true WHERE onboarding_id IS NULL;
ALTER TABLE companies ADD COLUMN current_mrr_cents integer CHECK (current_mrr_cents >= 0);
