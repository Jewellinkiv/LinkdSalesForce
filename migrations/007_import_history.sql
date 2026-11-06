ALTER TABLE external_records ADD COLUMN contact_id uuid REFERENCES contacts(id);
ALTER TABLE external_records ADD COLUMN opportunity_id uuid REFERENCES opportunities(id);
ALTER TABLE external_records ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
