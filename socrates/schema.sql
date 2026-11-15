-- Explicit pre-deploy migration only, after approval. The application never runs DDL.
CREATE TABLE IF NOT EXISTS socrates_schema(version INTEGER PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS socrates_private_updates(update_id BIGINT PRIMARY KEY,received_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS socrates_identity(author_id BIGINT PRIMARY KEY, master TEXT NOT NULL, confirmed_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS socrates_rates(
 master TEXT NOT NULL,effective_from DATE NOT NULL,effective_to DATE,base NUMERIC(14,2) NOT NULL CHECK(base>=0),
 bonus NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(bonus>=0),basis TEXT NOT NULL,PRIMARY KEY(master,effective_from),
 CHECK(effective_to IS NULL OR effective_to>=effective_from));
CREATE TABLE IF NOT EXISTS socrates_sources(
 chat_id BIGINT NOT NULL,message_id BIGINT NOT NULL,report_id BIGINT NOT NULL REFERENCES tg_reports(id),master TEXT,
 version BIGINT NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT now(),processed BOOLEAN NOT NULL DEFAULT false,review BOOLEAN NOT NULL DEFAULT false,
 PRIMARY KEY(chat_id,message_id));
CREATE TABLE IF NOT EXISTS socrates_jobs(
 master TEXT PRIMARY KEY,revision BIGINT NOT NULL DEFAULT 1,due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_token TEXT,lease_until TIMESTAMPTZ,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,needs_review BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS socrates_days(
 master TEXT NOT NULL,work_date DATE NOT NULL,revision BIGINT NOT NULL DEFAULT 0,protected BOOLEAN NOT NULL DEFAULT false,
 last_hash TEXT,source_version BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(master,work_date));
CREATE TABLE IF NOT EXISTS socrates_revisions(
 id BIGSERIAL PRIMARY KEY,master TEXT NOT NULL,work_date DATE NOT NULL,revision BIGINT NOT NULL,
 before_rows JSONB NOT NULL,after_rows JSONB NOT NULL,source_ids JSONB NOT NULL,basis TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(master,work_date,revision));
CREATE TABLE IF NOT EXISTS socrates_review(
 id BIGSERIAL PRIMARY KEY,master TEXT,source_ids JSONB NOT NULL,reason TEXT NOT NULL,draft JSONB,work_dates JSONB NOT NULL DEFAULT '[]',
 resolved BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS socrates_outbox(
 id BIGSERIAL PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,recipient BIGINT NOT NULL,text TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','cancelled')),
 due_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
 source_ids JSONB NOT NULL DEFAULT '[]',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),sent_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS socrates_runs(job_key TEXT PRIMARY KEY,state TEXT NOT NULL,lease_until TIMESTAMPTZ,last_error TEXT);
CREATE TABLE IF NOT EXISTS socrates_correction_batches(batch_hash TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),before_rows JSONB NOT NULL);
ALTER TABLE work_log ADD COLUMN IF NOT EXISTS socrates_minutes NUMERIC(14,6);
ALTER TABLE work_log ADD COLUMN IF NOT EXISTS socrates_source_ids JSONB;
ALTER TABLE work_log ADD COLUMN IF NOT EXISTS socrates_revision BIGINT;
ALTER TABLE work_log ADD COLUMN IF NOT EXISTS socrates_contributions JSONB;
CREATE INDEX IF NOT EXISTS socrates_pending_sources ON socrates_sources(master,processed);
CREATE INDEX IF NOT EXISTS socrates_pending_outbox ON socrates_outbox(status,created_at);
INSERT INTO socrates_schema(version) VALUES(2) ON CONFLICT DO NOTHING;
