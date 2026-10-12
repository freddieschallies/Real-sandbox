-- Department managers and van stock.
--
-- Each department has a manager; technicians in the department work under that manager. The
-- manager sets the department's van stock list (a bill of quantities): the spares every technician
-- in the department must carry. The stockroom issues van stock to a technician against the list,
-- and a van that is short of the list is flagged until it is complete again.

CREATE TABLE van_stock_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  department_id   uuid NOT NULL REFERENCES departments(id),
  stock_item_id   uuid NOT NULL REFERENCES stock_items(id),
  qty             numeric(10,2) NOT NULL CHECK (qty > 0),
  set_by          uuid NOT NULL REFERENCES users(id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, department_id, stock_item_id)
);
ALTER TABLE van_stock_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE van_stock_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON van_stock_lists USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- Every change to a list is kept.
CREATE TABLE van_stock_list_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  department_id   uuid NOT NULL REFERENCES departments(id),
  stock_item_id   uuid NOT NULL REFERENCES stock_items(id),
  old_qty         numeric(10,2),
  new_qty         numeric(10,2),
  changed_by      uuid NOT NULL REFERENCES users(id),
  changed_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE van_stock_list_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE van_stock_list_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON van_stock_list_changes USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER van_stock_list_changes_immutable BEFORE UPDATE OR DELETE ON van_stock_list_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- One open van-short flag per technician at a time.
CREATE UNIQUE INDEX flags_one_open_van_short ON flags (technician_id) WHERE flag_type = 'van_stock_short' AND status <> 'resolved';
