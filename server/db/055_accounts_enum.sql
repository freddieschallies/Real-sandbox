-- The Accounts position (the bookkeeper): every job card to check, quotes, invoices, credit notes,
-- supplier invoices, client rates and the Pastel batches.
ALTER TYPE login_level ADD VALUE 'accounts';
-- A supplier invoice the office scanned or picked as a file (photo or PDF).
ALTER TYPE photo_kind ADD VALUE 'supplier_doc';
