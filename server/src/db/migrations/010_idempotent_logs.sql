-- The request's Idempotency-Key on petty cash counts and asset upkeep logs, so a retried request returns the row it
-- already made instead of adding a second one (a count with no difference, or upkeep with no cost, posts no voucher
-- whose key could catch the retry). Safe to re-run.
ALTER TABLE petty_cash_counts ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS petty_cash_counts_idem_idx ON petty_cash_counts (company_id, idempotency_key);
ALTER TABLE asset_logs ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS asset_logs_idem_idx ON asset_logs (company_id, idempotency_key);
