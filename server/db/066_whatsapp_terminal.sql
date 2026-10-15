-- WhatsApp the easy way: the company chooses how the app gets its number when it sets up, and the app
-- shows every chat (the WhatsApp tab: read and reply).
--   phone:    the company's own cheap phone and SIM, linked once by scanning a QR code (in the existing groups).
--   official: an official WhatsApp Business number (Meta), no phone; stores message the number directly.
ALTER TABLE whatsapp_link
  ADD COLUMN mode              text NOT NULL DEFAULT 'phone' CHECK (mode IN ('phone', 'official')),
  ADD COLUMN wanted            boolean NOT NULL DEFAULT false,   -- the link service keeps this company's number linked
  ADD COLUMN link_requested_at timestamptz,                      -- "show the code": a fresh QR code from now
  ADD COLUMN test_sent_at      timestamptz,
  ADD COLUMN test_ok_at        timestamptz,
  ADD COLUMN official_number_id text,                            -- Meta's phone number id
  ADD COLUMN official_waba_id  text,
  ADD COLUMN official_name     text,                             -- the name WhatsApp shows
  ADD COLUMN official_token_enc text,                            -- kept scrambled
  ADD COLUMN breakdowns_from_chats boolean NOT NULL DEFAULT true; -- official number: messages to it come into Breakdowns
-- Before this, a company that ran the link service had chosen the phone way already.
UPDATE whatsapp_link SET wanted = true WHERE state <> 'not_linked';

-- Which company an official number belongs to: WhatsApp's webhook only says the number.
-- (Read before the company is known, so no company row security: the numbers are not secret.)
CREATE TABLE wa_official_numbers (
  phone_number_id text PRIMARY KEY,
  company_id      uuid NOT NULL UNIQUE REFERENCES companies(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wa_chats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  jid         text NOT NULL,                 -- WhatsApp's id of the chat (a group, or a person's number)
  name        text NOT NULL,
  is_group    boolean NOT NULL DEFAULT false,
  last_at     timestamptz,
  last_text   text,
  unread      integer NOT NULL DEFAULT 0,
  -- An official number may only send free text within 24 hours of the person's last message.
  last_in_at  timestamptz,
  UNIQUE (company_id, jid)
);
CREATE INDEX wa_chats_recent ON wa_chats (company_id, last_at DESC);
ALTER TABLE wa_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_chats FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON wa_chats USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE wa_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  chat_id      uuid NOT NULL REFERENCES wa_chats(id),
  wa_id        text,                          -- WhatsApp's id of the message (once it exists)
  from_me      boolean NOT NULL DEFAULT false, -- sent by the app's number (from the app, or from the phone itself)
  sender       text,
  sender_name  text,
  at           timestamptz NOT NULL,
  text         text NOT NULL DEFAULT '',
  photo_ids    uuid[] NOT NULL DEFAULT '{}',
  attachments  jsonb NOT NULL DEFAULT '[]',   -- names of what could not be kept (a PDF, a voice note…)
  status       text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'queued', 'sent', 'failed')),
  error        text,
  tries        integer NOT NULL DEFAULT 0,
  sent_by      uuid REFERENCES users(id),     -- who replied from the app
  breakdown_id uuid REFERENCES breakdowns(id),
  UNIQUE (company_id, wa_id)
);
CREATE INDEX wa_messages_chat ON wa_messages (company_id, chat_id, at DESC);
CREATE INDEX wa_messages_out ON wa_messages (company_id, at) WHERE status = 'queued';
ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON wa_messages USING (company_id = current_company()) WITH CHECK (company_id = current_company());

ALTER TYPE photo_kind ADD VALUE 'whatsapp';

-- The link service also says when it is starting, and when a QR code was not scanned in time.
ALTER TABLE whatsapp_link DROP CONSTRAINT whatsapp_link_state_check;
ALTER TABLE whatsapp_link ADD CONSTRAINT whatsapp_link_state_check CHECK (state IN ('not_linked', 'starting', 'waiting_for_scan', 'qr_expired', 'connected', 'logged_out'));
-- "Send a test" puts a line in the group.
ALTER TABLE group_posts DROP CONSTRAINT group_posts_reason_check;
ALTER TABLE group_posts ADD CONSTRAINT group_posts_reason_check CHECK (reason IN ('new', 'logged', 'merged', 'on_site', 'done', 'test'));

-- Pastel's guided set-up: when the practice import worked.
ALTER TABLE pastel_settings ADD COLUMN setup_done_at timestamptz;
