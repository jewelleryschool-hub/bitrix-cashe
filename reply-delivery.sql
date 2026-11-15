-- Explicit migration only. No startup DDL, message bodies or credentials.
CREATE TABLE IF NOT EXISTS romeo_reply_delivery (
 chat_id text NOT NULL,
 client_message_id text NOT NULL,
 token uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','processing','sending','accepted','suppressed')),
 attempts integer NOT NULL DEFAULT 1,
 dispatches integer NOT NULL DEFAULT 0,
 next_dispatch_at timestamptz NOT NULL DEFAULT now(),
 received_at timestamptz NOT NULL,
 lease_until timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(chat_id,client_message_id)
);
-- Sending is terminal for automatic retries even after a crash/ambiguous network result.

CREATE TABLE IF NOT EXISTS romeo_reply_attention (item_key text PRIMARY KEY, reason text NOT NULL, resolved_at timestamptz, last_seen_at timestamptz NOT NULL DEFAULT now());
