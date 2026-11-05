CREATE TABLE users (
  id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  password_hash text, role text NOT NULL CHECK (role IN ('admin','sales','onboarding')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE login_attempts (key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX login_attempts_key_time ON login_attempts(key,created_at);
CREATE TABLE companies (
  id uuid PRIMARY KEY, name text NOT NULL, city text NOT NULL DEFAULT '',
  website text NOT NULL DEFAULT '', pos text NOT NULL DEFAULT '',
  locations integer NOT NULL DEFAULT 1 CHECK (locations > 0),
  owner_id uuid NOT NULL REFERENCES users(id), source text NOT NULL DEFAULT 'Direct',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contacts (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '', sms_consent boolean NOT NULL DEFAULT false,
  email_consent boolean NOT NULL DEFAULT false, sms_opted_out boolean NOT NULL DEFAULT false,
  email_suppressed boolean NOT NULL DEFAULT false, consent_source text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_email_unique ON contacts(lower(email)) WHERE email <> '';
CREATE UNIQUE INDEX contacts_phone_unique ON contacts(phone) WHERE phone <> '';
CREATE TABLE opportunities (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
  contact_id uuid NOT NULL REFERENCES contacts(id), owner_id uuid NOT NULL REFERENCES users(id),
  stage text NOT NULL CHECK (stage IN ('New lead','Contacted','Demo scheduled','Decision','Won','Lost','Be back')),
  package text NOT NULL CHECK (package IN ('Full suite','Training only','Data & training','Texting')),
  mrr_cents integer NOT NULL DEFAULT 0 CHECK (mrr_cents >= 0),
  setup_cents integer NOT NULL DEFAULT 0 CHECK (setup_cents >= 0),
  next_action text NOT NULL DEFAULT '', next_action_at timestamptz,
  won_at timestamptz, lost_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE onboarding (
  id uuid PRIMARY KEY, opportunity_id uuid NOT NULL UNIQUE REFERENCES opportunities(id),
  company_id uuid NOT NULL REFERENCES companies(id), owner_id uuid NOT NULL REFERENCES users(id),
  phase text NOT NULL DEFAULT 'Handoff' CHECK (phase IN ('Handoff','Intake & pre-build','Working session','Training','Go-live','Adoption','Onboarded')),
  started_at timestamptz NOT NULL DEFAULT now(), phase_started_at timestamptz NOT NULL DEFAULT now(),
  target_at timestamptz NOT NULL, completed_at timestamptz, blocker text NOT NULL DEFAULT ''
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
  opportunity_id uuid REFERENCES opportunities(id), onboarding_id uuid REFERENCES onboarding(id),
  owner_id uuid NOT NULL REFERENCES users(id), title text NOT NULL, phase text,
  due_at timestamptz NOT NULL, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(onboarding_id,title)
);
CREATE INDEX tasks_due ON tasks(due_at) WHERE completed_at IS NULL;
CREATE TABLE activities (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid REFERENCES users(id), kind text NOT NULL, title text NOT NULL,
  body text NOT NULL DEFAULT '', metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_company ON activities(company_id,created_at DESC);
CREATE TABLE messages (
  id uuid PRIMARY KEY, company_id uuid REFERENCES companies(id), contact_id uuid REFERENCES contacts(id),
  user_id uuid REFERENCES users(id), channel text NOT NULL CHECK (channel IN ('sms','email')),
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  subject text NOT NULL DEFAULT '', body text NOT NULL, recipient text NOT NULL,
  status text NOT NULL DEFAULT 'queued', provider_id text UNIQUE,
  idempotency_key uuid UNIQUE, error text, scheduled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE calls (
  id uuid PRIMARY KEY, company_id uuid REFERENCES companies(id), contact_id uuid REFERENCES contacts(id),
  user_id uuid NOT NULL REFERENCES users(id), provider_id text UNIQUE, recording_sid text UNIQUE,
  transcript_sid text UNIQUE, direction text NOT NULL DEFAULT 'outbound', status text NOT NULL DEFAULT 'queued',
  duration integer NOT NULL DEFAULT 0, transcript jsonb NOT NULL DEFAULT '[]',
  summary text NOT NULL DEFAULT '', outcome text NOT NULL DEFAULT '',
  recording_consent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL,
  dedupe_key text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0, run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz, error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due ON jobs(run_at) WHERE status='pending';
CREATE TABLE webhook_events (
  provider text NOT NULL, event_key text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_key)
);
