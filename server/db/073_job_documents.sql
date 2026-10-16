-- Documents on a job card: forms and papers the office adds (a client's own service form to fill in,
-- a site permit, a manual), and the filled-in forms the technician brings back (as a file or a photo).
-- Never deleted: taking one off the job hides it, and the history keeps it.
ALTER TYPE photo_kind ADD VALUE 'job_form';

CREATE TABLE job_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  job_id        uuid NOT NULL REFERENCES jobs(id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind          text NOT NULL CHECK (kind IN ('for_site', 'filled_in')),
  file_path     text,
  content_type  text,
  bytes         integer,
  photo_id      uuid REFERENCES photos(id),
  note          text,
  added_by      uuid NOT NULL REFERENCES users(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  removed_by    uuid REFERENCES users(id),
  remove_reason text,
  CHECK (file_path IS NOT NULL OR photo_id IS NOT NULL)
);
CREATE INDEX job_documents_job ON job_documents (job_id) WHERE removed_at IS NULL;
ALTER TABLE job_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON job_documents USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- What was sent to whom (by email from the app, or a link to share on WhatsApp).
CREATE TABLE job_document_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  document_id   uuid NOT NULL REFERENCES job_documents(id),
  how           text NOT NULL CHECK (how IN ('email', 'link')),
  sent_to       text,
  sent_by       uuid NOT NULL REFERENCES users(id),
  sent_at       timestamptz NOT NULL DEFAULT now(),
  ok            boolean NOT NULL DEFAULT true,
  error         text
);
ALTER TABLE job_document_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_document_sends FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON job_document_sends USING (company_id = current_company()) WITH CHECK (company_id = current_company());
