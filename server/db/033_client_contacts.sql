-- A client's account code, main contact and how to reach them (brought over from Servcraft, or typed in).
ALTER TABLE clients ADD COLUMN account_code text;
ALTER TABLE clients ADD COLUMN contact_name text;
ALTER TABLE clients ADD COLUMN email text;
ALTER TABLE clients ADD COLUMN phone text;
ALTER TABLE clients ADD COLUMN imported_from text;   -- e.g. 'servcraft:<their id>'
