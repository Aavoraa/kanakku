-- Petty cash (imprest), editable masters, asset upkeep. Safe to re-run.

-- A petty cash box is a Cash-in-Hand ledger with a fixed float kept by a custodian.
CREATE TABLE IF NOT EXISTS petty_cash_boxes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  ledger_id            uuid NOT NULL UNIQUE REFERENCES ledgers(id),
  custodian            text,
  float_minor          bigint NOT NULL CHECK (float_minor > 0),
  voucher_limit_minor  bigint NOT NULL DEFAULT 500000 CHECK (voucher_limit_minor > 0),   -- Rs 5,000 per payment
  active               boolean NOT NULL DEFAULT true,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Physical cash counts, by note and coin, against the book balance.
CREATE TABLE IF NOT EXISTS petty_cash_counts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id                uuid NOT NULL REFERENCES petty_cash_boxes(id),
  company_id            uuid NOT NULL REFERENCES companies(id),
  count_date            date NOT NULL,
  denominations         jsonb NOT NULL,          -- {"500": 4, "100": 7, ...}
  coins_minor           bigint NOT NULL DEFAULT 0,
  counted_minor         bigint NOT NULL,
  book_minor            bigint NOT NULL,
  adjustment_voucher_id uuid REFERENCES vouchers(id),
  remarks               text,
  counted_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS petty_cash_counts_box_idx ON petty_cash_counts (box_id, count_date);

-- Stock items can be switched off like ledgers and parties.
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Asset register and upkeep: service / AMC / insurance schedules and a repair log.
CREATE TABLE IF NOT EXISTS assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  name            text NOT NULL,
  category        text,
  ledger_id       uuid REFERENCES ledgers(id),     -- the fixed-asset ledger it is booked in, if any
  location        text,
  serial_no       text,
  purchase_date   date,
  cost_minor      bigint,
  notes           text,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asset_schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES assets(id),
  company_id   uuid NOT NULL REFERENCES companies(id),
  kind         text NOT NULL CHECK (kind IN ('SERVICE','AMC','INSURANCE','WARRANTY','LICENCE','INSPECTION','OTHER')),
  title        text NOT NULL,
  next_due     date NOT NULL,
  repeat       text NOT NULL DEFAULT 'YEARLY' CHECK (repeat IN ('NONE','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY')),
  remind_days  int NOT NULL DEFAULT 15 CHECK (remind_days BETWEEN 0 AND 90),
  vendor       text,
  notes        text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_schedules_company_idx ON asset_schedules (company_id) WHERE active;

CREATE TABLE IF NOT EXISTS asset_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES assets(id),
  company_id   uuid NOT NULL REFERENCES companies(id),
  log_date     date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('REPAIR','SERVICE','AMC','INSURANCE','INSPECTION','OTHER')),
  description  text NOT NULL,
  cost_minor   bigint,
  voucher_id   uuid REFERENCES vouchers(id),        -- the expense voucher, when the cost was posted
  vendor       text,
  logged_by    uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_logs_asset_idx ON asset_logs (asset_id, log_date);
