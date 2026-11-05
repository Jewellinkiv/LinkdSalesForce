CREATE TABLE company_contacts (
 company_id uuid NOT NULL REFERENCES companies(id), contact_id uuid NOT NULL REFERENCES contacts(id),
 evidence text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,contact_id)
);
INSERT INTO company_contacts(company_id,contact_id) SELECT company_id,id FROM contacts;
CREATE FUNCTION attach_primary_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO company_contacts(company_id,contact_id) VALUES(NEW.company_id,NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$;
CREATE TRIGGER contact_primary_link AFTER INSERT OR UPDATE OF company_id ON contacts FOR EACH ROW EXECUTE FUNCTION attach_primary_contact();
ALTER TABLE messages ADD COLUMN opened_at timestamptz;
ALTER TABLE messages ADD COLUMN clicked_at timestamptz;
CREATE INDEX company_contacts_contact ON company_contacts(contact_id);
CREATE INDEX messages_company_history ON messages(company_id,created_at DESC,id DESC);
CREATE INDEX calls_company_history ON calls(company_id,created_at DESC,id DESC);
CREATE INDEX sequence_due ON sequence_enrollments(next_at) WHERE status='active';
