-- What each company has (set by the owner of Real Sandbox): the positions it uses (the work of one it
-- does not have goes to the CEO and whoever the CEO appoints) and the parts of the app it pays for.
-- NULL: everything (companies from before this).
ALTER TABLE companies ADD COLUMN positions text[];
ALTER TABLE companies ADD COLUMN parts text[];

-- Billing: what each company pays Real Sandbox, its invoices, paid or overdue. The owner's records about
-- the company (not the company's own records), so the owner's screens read them across companies;
-- a company's CEO only ever gets its own (routes/billing.ts).
CREATE TABLE company_billing (
  company         uuid PRIMARY KEY REFERENCES companies(id),   -- not company_id: these are not the company's own records (no row security, no history)
  plan_name       text NOT NULL DEFAULT 'Standard',
  base_cents      integer NOT NULL DEFAULT 0 CHECK (base_cents >= 0),
  per_user_cents  integer NOT NULL DEFAULT 0 CHECK (per_user_cents >= 0),
  free_users      integer NOT NULL DEFAULT 0 CHECK (free_users >= 0),
  billing_day     integer NOT NULL DEFAULT 1 CHECK (billing_day BETWEEN 1 AND 28),
  due_days        integer NOT NULL DEFAULT 7 CHECK (due_days BETWEEN 0 AND 60),
  grace_days      integer NOT NULL DEFAULT 14 CHECK (grace_days BETWEEN 0 AND 90),
  auto_suspend    boolean NOT NULL DEFAULT false,
  billing_email   text,
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE platform_invoice_seq START 1001;
CREATE TABLE platform_invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       integer NOT NULL UNIQUE DEFAULT nextval('platform_invoice_seq'),
  company      uuid NOT NULL REFERENCES companies(id),
  period       text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  plan_name    text NOT NULL,
  users        integer NOT NULL,
  lines        jsonb NOT NULL,
  amount_cents integer NOT NULL,
  issued_on    date NOT NULL,
  due_on       date NOT NULL,
  paid_at      timestamptz,
  paid_ref     text,
  cancelled_at timestamptz,
  cancel_note  text,
  reminded_at  timestamptz,                 -- the CEO was told it is overdue (once)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_invoices_one_a_month ON platform_invoices (company, period) WHERE cancelled_at IS NULL;

-- The owner's own details for the invoices: business name, banking details, VAT.
CREATE TABLE platform_settings (
  id             integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  business_name  text NOT NULL DEFAULT 'Real Sandbox',
  details        text,
  bank_details   text,
  vat_pct        numeric NOT NULL DEFAULT 15,
  vat_registered boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (id) VALUES (1);
