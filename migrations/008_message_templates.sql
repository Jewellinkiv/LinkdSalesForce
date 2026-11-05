CREATE TABLE message_templates (
 id uuid PRIMARY KEY, name text NOT NULL, subject text NOT NULL, body text NOT NULL,
 phase text CHECK(phase IN ('Intake & pre-build','Working session','Training','Go-live','Adoption')),
 automatic boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1, CHECK(NOT automatic OR phase IS NOT NULL)
);
CREATE UNIQUE INDEX one_automatic_template_per_phase ON message_templates(phase) WHERE automatic AND active;
INSERT INTO message_templates(id,name,subject,body,phase) VALUES
 ('00000000-0000-4000-8000-000000000001','Integration prerequisites','Preparing your Linkd integrations','Hi {{contact}},\n\nPlease confirm your POS/data access, team members who need access, and selected integrations before our working session. If texting is included, we will review the number, authorization paperwork and registration requirements together. Use your secure intake link for requested details; do not email passwords.\n\nReply with any blockers so we can prepare.','Intake & pre-build'),
 ('00000000-0000-4000-8000-000000000002','Working-session agenda','Your Linkd working-session agenda','Hi {{contact}},\n\nOur working session covers account access, user setup, data readiness and selected integrations. We will review blockers, confirm owners and dates, then agree on training and go-live next steps. Please include the person who manages your systems.','Working session');
UPDATE message_templates SET body=replace(body,E'\\n',E'\n');
