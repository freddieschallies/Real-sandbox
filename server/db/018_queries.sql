-- Queries: a question to a technician from the office or another technician, at any time,
-- optionally about a job. Both sides see the conversation; nothing is deleted.
CREATE TABLE queries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  from_user   uuid NOT NULL REFERENCES users(id),
  to_user     uuid NOT NULL REFERENCES users(id),
  job_id      uuid REFERENCES jobs(id),
  subject     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  from_read_at timestamptz,
  to_read_at  timestamptz,
  CHECK (from_user <> to_user)
);
CREATE INDEX queries_to ON queries (to_user, created_at DESC);
CREATE INDEX queries_from ON queries (from_user, created_at DESC);
ALTER TABLE queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE queries FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON queries USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE query_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  query_id    uuid NOT NULL REFERENCES queries(id),
  from_user   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL CHECK (length(trim(body)) >= 1),
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX query_messages_query ON query_messages (query_id, sent_at);
ALTER TABLE query_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE query_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON query_messages USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER query_messages_immutable BEFORE UPDATE OR DELETE ON query_messages FOR EACH ROW EXECUTE FUNCTION forbid_change();
