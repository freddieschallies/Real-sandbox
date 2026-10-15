-- Tech support from the platform owner, only when the CEO lets them in, and only for a set time.
-- The owner works through a hidden login of their own in the company ("Support: <name>"), so every
-- change shows in the company's history under that name.
ALTER TABLE users
  ADD COLUMN support_owner uuid REFERENCES platform_admins(id);   -- set only on the hidden support login

CREATE UNIQUE INDEX users_one_support_login ON users (company_id, support_owner) WHERE support_owner IS NOT NULL;

CREATE TABLE support_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  granted_by    uuid NOT NULL REFERENCES users(id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  until         timestamptz NOT NULL,
  reason        text,
  ended_at      timestamptz,
  ended_by      uuid REFERENCES users(id),
  entered_at    timestamptz,             -- the first time support opened the company
  entered_by    text                     -- who that was (the owner's name)
);
CREATE INDEX support_grants_open ON support_grants (company_id) WHERE ended_at IS NULL;
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON support_grants USING (company_id = current_company()) WITH CHECK (company_id = current_company());
