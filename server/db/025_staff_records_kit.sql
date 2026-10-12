-- Staff records on each person's profile, and each person's tools and PPE.
--
-- Staff records: issues, warnings and commendations build a history per person. Only the CEO and
-- whoever the CEO gives "Staff records (HR)" may read, add or delete them. Entries cannot be edited
-- (a correction is a new entry); they can be deleted, and a deletion leaves a line saying who deleted
-- a record from which date, and when, but not what it said.

DROP TRIGGER employee_log_immutable ON employee_log_entries;
CREATE TRIGGER employee_log_no_edit BEFORE UPDATE ON employee_log_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE employee_log_entries DROP CONSTRAINT employee_log_entries_corrects_entry_id_fkey;
ALTER TABLE employee_log_entries ADD CONSTRAINT employee_log_entries_corrects_entry_id_fkey
  FOREIGN KEY (corrects_entry_id) REFERENCES employee_log_entries(id) ON DELETE CASCADE;
ALTER TABLE employee_log_entries ADD COLUMN happened_on date NOT NULL DEFAULT current_date;

CREATE TABLE employee_log_deletions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  employee_id     uuid NOT NULL REFERENCES users(id),
  entry_happened_on date NOT NULL,
  deleted_by      uuid NOT NULL REFERENCES users(id),
  deleted_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE employee_log_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_log_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON employee_log_deletions USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER employee_log_deletions_immutable BEFORE UPDATE OR DELETE ON employee_log_deletions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Tools and PPE: the stockroom keeps each person's list. An item stays on the list until it is
-- returned, lost or damaged (lost and damaged need a note). Items taken from stock go back to stock
-- when returned.
CREATE TABLE person_kit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  kind            text NOT NULL CHECK (kind IN ('tool', 'ppe')),
  name            text NOT NULL CHECK (length(trim(name)) >= 2),
  detail          text,                         -- size, serial number, make
  qty             numeric(10,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
  stock_item_id   uuid REFERENCES stock_items(id),
  replace_by      date,                         -- PPE that expires or wears out (e.g. harness, gloves)
  issued_by       uuid NOT NULL REFERENCES users(id),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'returned', 'lost', 'damaged')),
  closed_by       uuid REFERENCES users(id),
  closed_at       timestamptz,
  close_note      text,
  CHECK ((status = 'issued') = (closed_at IS NULL)),
  CHECK (status NOT IN ('lost', 'damaged') OR length(trim(coalesce(close_note, ''))) >= 5)
);
CREATE INDEX person_kit_user ON person_kit (user_id, status);
ALTER TABLE person_kit ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_kit FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON person_kit USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- Once an item is closed it is history and stays as it is.
CREATE FUNCTION person_kit_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'tool and PPE records cannot be deleted'; END IF;
  IF OLD.status <> 'issued' THEN RAISE EXCEPTION 'this item is already %', OLD.status; END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.qty <> OLD.qty OR NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id OR NEW.issued_at <> OLD.issued_at THEN
    RAISE EXCEPTION 'only the details, replace-by date and status of an issued item can change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER person_kit_lock BEFORE UPDATE OR DELETE ON person_kit FOR EACH ROW EXECUTE FUNCTION person_kit_locked();

ALTER TABLE stock_movements ADD COLUMN person_kit_id uuid REFERENCES person_kit(id);

-- Stock, tools and PPE are separate categories in the stockroom. Technicians book only stock onto
-- jobs; tools and PPE are issued to a person and kept on their list.
ALTER TABLE stock_items ADD COLUMN category text NOT NULL DEFAULT 'stock' CHECK (category IN ('stock', 'tool', 'ppe'));
