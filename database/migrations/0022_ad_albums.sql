-- ============================================================================
-- LIKApcs migration 0022 — albums for the customer-screen slideshow (0.12.0).
--
-- Until now every slide shared one layout (Settings › Client screen › Slideshow). An *album* is
-- a named group of slides with its own look: album 1 can be a 3×3 grid of products, album 2
-- edge-to-edge photos, album 3 a menu board. The PCs play the albums one after another, in
-- `sort_order` — album 1 completely, then album 2, … — and start over.
--
-- Every look column is nullable: NULL = "as in Settings" (the owner's default), so an album can
-- override only what it needs. `enabled = false` takes the whole album off the screens at once.
-- Slides without an album keep behaving exactly as before (they play first, with the defaults),
-- so nothing changes on upgrade until the owner creates an album.
-- ============================================================================

CREATE TABLE ad_albums (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  layout           text CHECK (layout IS NULL OR layout IN ('card', 'full', 'grid', 'menu')),
  grid             text CHECK (grid IS NULL OR grid IN ('2x2', '3x2', '4x2', '3x3', '4x3', '4x4')),
  image_fit        text CHECK (image_fit IS NULL OR image_fit IN ('contain', 'cover')),
  caption          text CHECK (caption IS NULL OR caption IN ('bottom', 'top', 'hidden')),
  style            text CHECK (style IS NULL OR style IN ('poster', 'hero', 'split', 'banner')),
  interval_seconds integer CHECK (interval_seconds IS NULL OR interval_seconds BETWEEN 3 AND 120),
  shuffle          boolean,
  enabled          boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_albums_order ON ad_albums (sort_order, created_at);
CREATE TRIGGER ad_albums_set_updated_at BEFORE UPDATE ON ad_albums
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A slide belongs to at most one album; deleting the album only ungroups its slides.
ALTER TABLE ads ADD COLUMN album_id uuid REFERENCES ad_albums(id) ON DELETE SET NULL;
CREATE INDEX ads_album_order ON ads (album_id, sort_order, created_at);
