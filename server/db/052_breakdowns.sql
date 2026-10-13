-- Breakdowns coming in: the company's Gmail inboxes (customers and the call centre's logged calls)
-- and the WhatsApp breakdowns group. Each message lands in one queue with what the app read from it
-- (store, fault, call log number). Nothing leaves the queue until someone logs it as a job, adds it
-- to a job that is already open, or marks it "not a job". The app's own WhatsApp number posts new
-- breakdowns and job updates to the group.

-- Where messages come from: a Gmail inbox (read with an app password, kept scrambled) or the group.
CREATE TABLE intake_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  kind          text NOT NULL CHECK (kind IN ('gmail')),
  address       text NOT NULL,
  secret_enc    text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  uid_validity  bigint,
  last_uid      bigint,
  last_checked_at timestamptz,
  last_error    text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, address)
);
ALTER TABLE intake_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON intake_sources USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- The app's WhatsApp number: linked or not, the QR code to link it, the groups it is in, and which
-- group is the breakdowns group. One row per company.
CREATE TABLE whatsapp_link (
  company_id    uuid PRIMARY KEY DEFAULT current_company() REFERENCES companies(id),
  state         text NOT NULL DEFAULT 'not_linked' CHECK (state IN ('not_linked', 'waiting_for_scan', 'connected', 'logged_out')),
  qr_svg        text,
  number        text,
  groups        jsonb NOT NULL DEFAULT '[]',
  group_jid     text,
  group_name    text,
  seen_at       timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE whatsapp_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_link FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON whatsapp_link USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- What gets posted to the group, and how long a breakdown may wait before the CEO is told.
CREATE TABLE breakdown_settings (
  company_id      uuid PRIMARY KEY DEFAULT current_company() REFERENCES companies(id),
  post_new        boolean NOT NULL DEFAULT true,
  post_logged     boolean NOT NULL DEFAULT true,
  post_on_site    boolean NOT NULL DEFAULT false,
  post_done       boolean NOT NULL DEFAULT false,
  escalate_after_min integer NOT NULL DEFAULT 15 CHECK (escalate_after_min BETWEEN 5 AND 240),
  ignore_senders  text[] NOT NULL DEFAULT '{}',
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE breakdown_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE breakdown_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON breakdown_settings USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE breakdowns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  channel       text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  source_id     uuid REFERENCES intake_sources(id),
  external_id   text NOT NULL,                 -- the email's Message-ID or the WhatsApp message id
  received_at   timestamptz NOT NULL,
  sender_name   text,
  sender        text,                          -- email address or phone number
  subject       text,
  body          text NOT NULL DEFAULT '',
  photo_ids     uuid[] NOT NULL DEFAULT '{}',
  attachments   jsonb NOT NULL DEFAULT '[]',   -- names of other attachments (PDFs, ...)
  -- What the app read from it (the office checks it before anything is logged).
  kind          text NOT NULL CHECK (kind IN ('breakdown', 'inquiry', 'other')),
  read_by       text NOT NULL CHECK (read_by IN ('ai', 'rules')),
  store_id      uuid REFERENCES stores(id),
  store_text    text,
  fault         text,
  call_ref      text,
  urgent        boolean NOT NULL DEFAULT false,
  -- What happened to it.
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'logged', 'merged', 'ignored')),
  job_id        uuid REFERENCES jobs(id),
  handled_by    uuid REFERENCES users(id),
  handled_at    timestamptz,
  note          text,
  escalated_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, channel, external_id),
  CHECK ((status IN ('logged', 'merged')) = (job_id IS NOT NULL)),
  CHECK ((status = 'new') = (handled_at IS NULL))
);
CREATE INDEX breakdowns_new ON breakdowns (company_id, received_at) WHERE status = 'new';
CREATE INDEX breakdowns_ref ON breakdowns (company_id, call_ref) WHERE call_ref IS NOT NULL;
ALTER TABLE breakdowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE breakdowns FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON breakdowns USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- Messages for the app's WhatsApp number to post in the breakdowns group.
CREATE TABLE group_posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  text          text NOT NULL,
  breakdown_id  uuid REFERENCES breakdowns(id),
  job_id        uuid REFERENCES jobs(id),
  reason        text NOT NULL CHECK (reason IN ('new', 'logged', 'merged', 'on_site', 'done')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  wa_id         text,                          -- the posted message's id, so the app knows its own posts
  error         text,
  tries         integer NOT NULL DEFAULT 0
);
CREATE INDEX group_posts_waiting ON group_posts (company_id, created_at) WHERE sent_at IS NULL;
ALTER TABLE group_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_posts FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON group_posts USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- A picture that came in with a breakdown was not taken by anyone in the company.
ALTER TABLE photos ALTER COLUMN taken_by DROP NOT NULL;
