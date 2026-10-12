-- Each person's profile: picture, emergency contact and personal details. Contact details (phone,
-- email, emergency contact) are for the office; personal details only for whoever manages access.
CREATE TABLE user_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id),
  company_id       uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  photo_id         uuid REFERENCES photos(id),
  emergency_name   text,
  emergency_phone  text,
  id_number        text,
  date_of_birth    date,
  home_address     text,
  start_date       date,
  notes            text,
  updated_by       uuid NOT NULL REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON user_profiles USING (company_id = current_company()) WITH CHECK (company_id = current_company());
