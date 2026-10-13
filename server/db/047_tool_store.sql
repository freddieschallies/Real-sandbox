-- The stockroom's own tools and ladders (shared, not on anyone's name for good): each with a serial
-- number and a barcode sticker. The stock controller books one out to a person (for a job), who
-- signs for it; when the job is done it is signed back in, with its condition. One booking open per
-- tool at a time; a booking is kept for good.
CREATE TABLE store_tools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  name        text NOT NULL CHECK (length(trim(name)) >= 2),
  kind        text NOT NULL DEFAULT 'tool' CHECK (kind IN ('tool', 'ladder', 'equipment')),
  serial      text,
  barcode     text NOT NULL,
  notes       text,
  condition   text NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'damaged', 'lost')),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, barcode)
);
ALTER TABLE store_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_tools FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON store_tools USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE tool_bookings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  tool_id                   uuid NOT NULL REFERENCES store_tools(id),
  user_id                   uuid NOT NULL REFERENCES users(id),
  job_id                    uuid REFERENCES jobs(id),
  out_at                    timestamptz NOT NULL DEFAULT now(),
  out_by                    uuid NOT NULL REFERENCES users(id),
  out_signature_photo_id    uuid NOT NULL REFERENCES photos(id),
  out_note                  text,
  returned_at               timestamptz,
  returned_by               uuid REFERENCES users(id),
  return_signature_photo_id uuid REFERENCES photos(id),
  return_condition          text CHECK (return_condition IN ('good', 'damaged', 'lost')),
  return_note               text,
  CHECK ((returned_at IS NULL) = (return_condition IS NULL))
);
CREATE UNIQUE INDEX tool_bookings_one_open ON tool_bookings (tool_id) WHERE returned_at IS NULL;
CREATE INDEX tool_bookings_user ON tool_bookings (user_id) WHERE returned_at IS NULL;
ALTER TABLE tool_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON tool_bookings USING (company_id = current_company()) WITH CHECK (company_id = current_company());
-- A booking can be signed back once, and is never changed after that or deleted.
CREATE FUNCTION tool_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.returned_at IS NOT NULL OR NEW.tool_id <> OLD.tool_id OR NEW.user_id <> OLD.user_id OR NEW.out_at <> OLD.out_at
     OR NEW.out_signature_photo_id <> OLD.out_signature_photo_id OR NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION 'a tool booking cannot be changed after it is made, only signed back once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tool_bookings_guard BEFORE UPDATE OR DELETE ON tool_bookings FOR EACH ROW EXECUTE FUNCTION tool_booking_guard();
