-- Every person signs in with their own email and password. The office (HR or the CEO) gives a
-- one-time setup code; the person chooses their own password with it, so nobody else knows it.
-- A new code is also how a forgotten password is reset. Wrong passwords lock the login for a while.

ALTER TABLE users
  ADD COLUMN session_epoch   integer NOT NULL DEFAULT 0,   -- raised to sign the person out on every phone
  ADD COLUMN failed_logins   integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until    timestamptz,
  ADD COLUMN password_set_at timestamptz,
  ADD COLUMN last_login_at   timestamptz;

-- Whoever can sign in today chose a password already (the CEO made with the company).
UPDATE users SET password_set_at = created_at WHERE login_enabled;

CREATE TABLE login_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  code_hash   text NOT NULL,
  issued_by   uuid NOT NULL REFERENCES users(id),
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  wrong_tries integer NOT NULL DEFAULT 0,
  used_at     timestamptz,
  cancelled_at timestamptz,
  cancel_reason text
);
-- One code waiting per person: a new one cancels the old one.
CREATE UNIQUE INDEX login_codes_one_open ON login_codes (user_id) WHERE used_at IS NULL AND cancelled_at IS NULL;
ALTER TABLE login_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON login_codes USING (company_id = current_company()) WITH CHECK (company_id = current_company());
