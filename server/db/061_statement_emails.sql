-- Every statement emailed to a customer: when, to whom, by whom, the period and the balance.
CREATE TABLE statement_emails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  client_id   uuid NOT NULL REFERENCES clients(id),
  sent_to     text[] NOT NULL,
  period_from date,
  period_to   date NOT NULL,
  balance_cents bigint NOT NULL,
  sent_by     uuid NOT NULL REFERENCES users(id),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  error       text
);
ALTER TABLE statement_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON statement_emails USING (company_id = current_company()) WITH CHECK (company_id = current_company());
