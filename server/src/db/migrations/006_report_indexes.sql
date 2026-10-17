-- Indexes for joins and report filters that otherwise scan whole tables as the books grow. Safe to re-run.
CREATE INDEX IF NOT EXISTS voucher_tax_lines_company_date_idx ON voucher_tax_lines (company_id, voucher_date);
CREATE INDEX IF NOT EXISTS voucher_tax_lines_voucher_idx ON voucher_tax_lines (voucher_id);
CREATE INDEX IF NOT EXISTS bill_allocations_entry_idx ON bill_allocations (ledger_entry_id);
CREATE INDEX IF NOT EXISTS inventory_entries_voucher_idx ON inventory_entries (voucher_id);
-- Ledger statements, balances and the masters lists filter ledger_entries by ledger alone.
CREATE INDEX IF NOT EXISTS ledger_entries_ledger_date_idx ON ledger_entries (ledger_id, voucher_date);
CREATE INDEX IF NOT EXISTS ledger_entries_voucher_idx ON ledger_entries (voucher_id);
CREATE INDEX IF NOT EXISTS vouchers_reverses_idx ON vouchers (reverses_voucher_id) WHERE reverses_voucher_id IS NOT NULL;
