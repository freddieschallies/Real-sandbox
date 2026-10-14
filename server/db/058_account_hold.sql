-- An account on hold: the CEO or Accounts puts a client that is not paying on hold, with the reason.
-- Opening a job for it then warns and must be confirmed (Accounts is told). Every change is kept.
ALTER TABLE clients ADD COLUMN on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN hold_reason text;
ALTER TABLE clients ADD COLUMN hold_by uuid REFERENCES users(id);
ALTER TABLE clients ADD COLUMN hold_at timestamptz;
ALTER TABLE clients ADD CONSTRAINT clients_hold_reason CHECK (NOT on_hold OR length(trim(coalesce(hold_reason, ''))) >= 3);

CREATE TABLE client_hold_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  client_id   uuid NOT NULL REFERENCES clients(id),
  on_hold     boolean NOT NULL,
  reason      text,
  job_id      uuid REFERENCES jobs(id),      -- a job opened anyway while on hold
  by_user     uuid NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE client_hold_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_hold_log FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON client_hold_log USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER client_hold_log_immutable BEFORE UPDATE OR DELETE ON client_hold_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
