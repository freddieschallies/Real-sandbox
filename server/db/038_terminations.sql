-- When someone's employment ends, HR (or the CEO) records it: the person is taken off every list,
-- their login stops, and they move to HR's Terminated staff with this record, which cannot be
-- changed. What was still on their name (tools, PPE, van stock) is kept with it for the stockroom.
CREATE TABLE terminations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  terminated_on   date NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('resigned', 'dismissed', 'retrenched', 'contract_ended', 'retired', 'other')),
  note            text,
  position        text NOT NULL,
  department      text,
  on_name         jsonb NOT NULL DEFAULT '{}',
  terminated_by   uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id)
);
ALTER TABLE terminations ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminations FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON terminations USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER terminations_immutable BEFORE UPDATE OR DELETE ON terminations FOR EACH ROW EXECUTE FUNCTION forbid_change();
