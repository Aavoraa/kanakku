-- Compliance calendar: which statutory returns apply, filing records, and the company's own reminders. Safe to re-run.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS compliance jsonb NOT NULL DEFAULT '{}';

-- One row per obligation occurrence (key such as 'GSTR3B:2026-09:2026-09' or 'TASK:<id>:2026-10-31') that has been
-- filed or paid, or whose due date was extended. Nothing here is generated: the calendar computes the occurrences.
CREATE TABLE IF NOT EXISTS compliance_records (
  company_id    uuid NOT NULL REFERENCES companies(id),
  key           text NOT NULL,
  done_on       date,                 -- filed / paid / finished on
  reference     text,                 -- ARN, acknowledgement no., challan CIN / BRN
  amount_minor  bigint,               -- tax paid, in paise
  notes         text,
  due_date      date,                 -- extended due date, when the government extends it
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

CREATE TABLE IF NOT EXISTS compliance_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  title        text NOT NULL,
  category     text NOT NULL CHECK (category IN ('WORKING','CALCULATION','ADJUSTMENT','FILING','PAYMENT','OTHER')),
  first_due    date NOT NULL,
  repeat       text NOT NULL DEFAULT 'NONE' CHECK (repeat IN ('NONE','MONTHLY','QUARTERLY','YEARLY')),
  remind_days  int NOT NULL DEFAULT 3 CHECK (remind_days BETWEEN 0 AND 60),
  notes        text,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compliance_tasks_company_idx ON compliance_tasks (company_id) WHERE active;
