-- Purchase orders made outside the app (by admin, in Pastel) and posted in the WhatsApp purchase
-- orders group: read automatically and added like the app's own, linked to the job, its technician
-- and the stock items, so the books stay balanced.
ALTER TABLE whatsapp_link ADD COLUMN po_group_jid text;
ALTER TABLE whatsapp_link ADD COLUMN po_group_name text;

ALTER TABLE purchase_orders ALTER COLUMN technician_id DROP NOT NULL;
ALTER TABLE purchase_orders ADD COLUMN source text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'group'));
ALTER TABLE purchase_orders ADD COLUMN external_number text;
ALTER TABLE purchase_orders ADD COLUMN posted_by text;
ALTER TABLE purchase_orders ADD COLUMN message_id text;
ALTER TABLE purchase_orders ADD COLUMN photo_id uuid REFERENCES photos(id);
ALTER TABLE purchase_orders ADD COLUMN read_by text;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_who CHECK (technician_id IS NOT NULL OR source = 'group');
-- An app PO is approved by someone; one posted in the group was already issued.
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_decided CHECK (source = 'group' OR status NOT IN ('approved', 'rejected', 'collected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL));
CREATE UNIQUE INDEX purchase_orders_message ON purchase_orders (company_id, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX purchase_orders_external ON purchase_orders (company_id, lower(supplier_name), lower(external_number)) WHERE external_number IS NOT NULL AND status <> 'cancelled';
