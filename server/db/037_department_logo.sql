-- Each department can have its own logo (HR or the CEO sets it, like the name). It shows wherever
-- the department does.
ALTER TABLE departments ADD COLUMN logo_photo_id uuid REFERENCES photos(id);
