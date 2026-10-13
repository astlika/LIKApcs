/**
 * The page sequence of the slideshow lives in the shared package since 0.16.0 (the Admin's
 * customer display plays the same program). Re-exported here so the client keeps its imports.
 */
export {
  buildPages,
  buildProgram,
  chunk,
  planAlbums,
  type AdsPage,
  type AlbumPlan,
  type BarePage,
} from '@likapcs/shared';
