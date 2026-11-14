-- Apply explicitly before enabling LIFT_DURABLE_ENABLED. No automatic startup DDL.
-- Identifiers and status only; no customer text, names, phones or API keys.
CREATE TABLE IF NOT EXISTS romeo_lift_delivery (
  chat_id text NOT NULL,
  client_message_id text NOT NULL,
  claim_token uuid NOT NULL,
  status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','accepted','skipped','uncertain')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (chat_id, client_message_id)
);
-- Never expire/delete a claim automatically: a lost response may conceal a successful send.
