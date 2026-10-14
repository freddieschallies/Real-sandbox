-- A new company carries on its numbering from the previous system: the CEO or Accounts ticks the
-- next job card, invoice, quote, credit note and purchase order numbers as right.
ALTER TABLE company_setup ADD COLUMN numbers_checked boolean NOT NULL DEFAULT false;
