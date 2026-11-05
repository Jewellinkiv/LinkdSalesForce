export const stages = [
  "New lead",
  "Contacted",
  "Qualified",
  "Demo scheduled",
  "Need next meeting",
  "Decision",
  "Won",
  "Lost",
  "Be back",
] as const;
export const phases = [
  "Handoff",
  "Intake & pre-build",
  "Working session",
  "Training",
  "Go-live",
  "Adoption",
  "Onboarded",
] as const;
export const packages = [
  "Undecided",
  "Full suite",
  "Training only",
  "Data & training",
  "Texting",
] as const;
export type User = {
  active?: boolean;
  id: string;
  name: string;
  email: string;
  role: "admin" | "sales" | "onboarding";
};
export type Contact = {
  id: string;
  company_id: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  version: number;
  sms_consent: boolean;
  email_consent: boolean;
  sms_opted_out: boolean;
  email_suppressed: boolean;
  do_not_contact: boolean;
  consent_source: string;
  restriction_reason: string;
};
export type Customer = {
  current_mrr_cents: number | null;
  version: number;
  contact_version: number;
  opportunity_version: number;
  lifecycle: "prospect" | "onboarding" | "active" | "paused" | "churned";
  do_not_contact: boolean;
  contact_do_not_contact: boolean;
  restriction_reason: string;
  consent_source: string;
  kind: "lead" | "deal";
  opportunity_owner_id: string;
  source_lead_id: string | null;
  setup_cents: number;
  discount_cents: number;
  effective_date: string | null;
  appointment_at: string | null;
  won_at: string | null;
  closed_at: string | null;
  id: string;
  name: string;
  city: string;
  pos: string;
  locations: number;
  source: string;
  owner_id: string;
  owner_name: string;
  contact_id: string;
  contact_name: string;
  email: string;
  phone: string;
  sms_consent: boolean;
  email_consent: boolean;
  sms_opted_out: boolean;
  email_suppressed: boolean;
  opportunity_id: string;
  stage: (typeof stages)[number];
  package: (typeof packages)[number];
  mrr_cents: number;
  next_action: string;
  next_action_at: string | null;
  created_at: string;
};
export type Task = {
  resolution: "open" | "completed" | "superseded" | "cancelled";
  opportunity_id: string | null;
  id: string;
  company_id: string;
  company_name: string;
  owner_id: string;
  owner_name: string;
  title: string;
  phase: string | null;
  due_at: string;
  completed_at: string | null;
  onboarding_id: string | null;
};
export type Project = {
  version: number;
  owner_id: string;
  cs_owner_id: string | null;
  sales_owner_id: string | null;
  source: string;
  go_live_at: string | null;
  billing_at: string | null;
  intake_received_at: string | null;
  phase_started_at: string;
  readiness: Record<string, { status: string; notes: string }>;
  id: string;
  company_id: string;
  company_name: string;
  owner_name: string;
  phase: (typeof phases)[number];
  started_at: string;
  target_at: string;
  blocker: string;
  package: string;
  total_tasks: number;
  completed_tasks: number;
  mrr_cents: number;
};
export type Activity = {
  id: string;
  company_id: string;
  company_name: string;
  kind: string;
  title: string;
  body: string;
  actor: string | null;
  created_at: string;
};
export type Message = {
  id: string;
  company_id: string | null;
  company_name: string | null;
  contact_name: string | null;
  channel: "email" | "sms";
  direction: string;
  subject: string;
  body: string;
  status: string;
  error: string | null;
  created_at: string;
  scheduled_at: string;
};
export type Call = {
  id: string;
  company_id: string | null;
  company_name: string | null;
  contact_name: string | null;
  user_name: string;
  status: string;
  duration: number;
  summary: string;
  outcome: string;
  recording_sid: string | null;
  transcript: { speaker: string; text: string; time: number }[];
  created_at: string;
};
export type Integration = {
  name: string;
  ready: boolean;
  missing: string[];
  description: string;
};
export type Workspace = {
  user: User;
  users: User[];
  customers: Customer[];
  opportunities: Customer[];
  contacts: Contact[];
  notifications: {
    id: string;
    company_id: string | null;
    title: string;
    body: string;
    read_at: string | null;
    created_at: string;
  }[];
  automation: { welcome: boolean; intakeNudge: boolean; schedulingUrl: string };
  tasks: Task[];
  projects: Project[];
  activities: Activity[];
  messages: Message[];
  calls: Call[];
  config: {
    demo: boolean;
    communicationMode: string;
    recordingEnabled: boolean;
    integrations: Integration[];
  };
  jobs: { kind: string; status: string; count: number }[];
};
