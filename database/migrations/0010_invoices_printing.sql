-- ============================================================================
-- LIKApcs migration 0010 — invoices (A4 documents issued from completed sales) and
-- printing settings.
--
-- An invoice is a numbered (F-<year>-NNNNNN, gap-free) legal document for one sale. It
-- snapshots the buyer details at issue time; the lines come from the immutable sale.
-- Only one live invoice may exist per sale; a voided invoice keeps its number.
-- ============================================================================

ALTER TABLE invoices
  ADD COLUMN status        text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  ADD COLUMN billing_email text,
  ADD COLUMN notes         text,
  ADD COLUMN due_at        date,
  ADD COLUMN voided_at     timestamptz,
  ADD COLUMN voided_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN void_reason   text;

CREATE UNIQUE INDEX invoices_one_live_per_sale ON invoices (sale_id)
  WHERE kind = 'invoice' AND status = 'issued';
CREATE INDEX invoices_issued_at_idx ON invoices (issued_at DESC);
CREATE INDEX invoices_customer_idx ON invoices (customer_id) WHERE customer_id IS NOT NULL;

-- Permissions: issuing/voiding invoices is a POS-level task; reading them is finance.
INSERT INTO permissions (code, category, description) VALUES
  ('invoices.view',   'pos', 'View and print invoices'),
  ('invoices.manage', 'pos', 'Issue and void invoices');

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
  WHERE r.code IN ('owner', 'admin', 'manager', 'cashier')
    AND p.code IN ('invoices.view', 'invoices.manage')
  ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'invoices.view' FROM roles r WHERE r.code = 'accountant'
  ON CONFLICT DO NOTHING;

-- Printing settings (receipt settings already exist under pos.*).
INSERT INTO settings (key, value) VALUES
  ('printing.invoice_due_days',     '0'),
  ('printing.invoice_bank_details', '""'),
  ('printing.invoice_footer',       '""')
ON CONFLICT (key) DO NOTHING;
