-- Financial-year voucher numbers (SI/27-28/0001) and reminders by email, WhatsApp and SMS. Safe to re-run.

-- From this date, numbers carry a type code and the financial year. Companies that already exist switch at the start
-- of their next financial year, so the current year's invoice series stays unbroken (GST rule 46).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fy_numbering_from date;
UPDATE companies
   SET fy_numbering_from = make_date(
         EXTRACT(YEAR FROM current_date)::int + CASE WHEN EXTRACT(MONTH FROM current_date)::int >= fy_start_month THEN 1 ELSE 0 END,
         fy_start_month, 1)
 WHERE fy_numbering_from IS NULL;

-- Where reminder digests go, per company. Holds passwords and tokens: the API never returns them to the browser.
CREATE TABLE IF NOT EXISTS notification_settings (
  company_id  uuid PRIMARY KEY REFERENCES companies(id),
  config      jsonb NOT NULL DEFAULT '{}',
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every digest sent (or that failed), so a day's digest goes once and failures can be seen.
CREATE TABLE IF NOT EXISTS notification_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  channel      text NOT NULL CHECK (channel IN ('EMAIL','WHATSAPP','SMS')),
  digest_date  date NOT NULL,
  recipient    text NOT NULL,
  status       text NOT NULL CHECK (status IN ('SENT','FAILED')),
  error        text,
  items        int NOT NULL DEFAULT 0,
  test         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_log_day_idx ON notification_log (company_id, channel, digest_date);
