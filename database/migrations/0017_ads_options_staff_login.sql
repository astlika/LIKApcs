-- ============================================================================
-- LIKApcs migration 0017 — more options for ads + one-click staff login on the PCs.
--
-- * `ads.theme`: a colour preset for the slide background (card / text slides and the picture
--   frame). NULL = the default "midnight" look. Presets are fixed so every PC renders the same.
-- * `ads.duration_seconds`: how long this slide stays on screen; NULL = the owner's global
--   interval (`client.ads_interval_seconds`). "Keep the happy-hour slide longer" without
--   touching the others.
-- * Product ads may now carry a short text (`body`, column existed) shown under the name
--   ("2 for 1 until 20:00") — no schema change, documented here for completeness.
-- * Policy change (code only): a product ad stays on the screens while the product is *active*;
--   being out of stock no longer hides it (most shops do not keep exact counts). Archived
--   products still disappear by themselves.
-- * `client.staff_login_username`: the username pre-filled in the staff login that opens with a
--   left click on the locked screen (0.7.1). Empty = nothing pre-filled.
-- ============================================================================

ALTER TABLE ads
  ADD COLUMN theme text CHECK (
    theme IS NULL OR theme IN ('midnight', 'ocean', 'sunset', 'forest', 'ruby', 'gold', 'mono')
  ),
  ADD COLUMN duration_seconds integer CHECK (
    duration_seconds IS NULL OR duration_seconds BETWEEN 3 AND 120
  );

INSERT INTO settings (key, value) VALUES ('client.staff_login_username', '""');
