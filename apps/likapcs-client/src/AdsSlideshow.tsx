/**
 * Lock-screen slideshow (ads v2, 0.10.0).
 *
 * Pictures are decoded *before* they are shown (an `Image()` preload gate per slide) and two
 * layers cross over with CSS transforms only, so there is never a flash of an empty frame or a
 * half-loaded photo.
 *
 * Page layouts (owner setting `client.ads_layout`):
 *  - `card` / `full`  one slide per page; the slide's own *style* decides the composition
 *                     (`poster` edge-to-edge photo, `hero` picture + text, `split` half/half,
 *                     `banner` compact strip) — per ad, else the owner's default style
 *                     (`full` defaults to the poster, as before 0.10.0);
 *  - `grid`           a box of cols × rows products that advances one page at a time;
 *  - `menu`           a price board (name … price) in columns, custom slides in between.
 *
 * Each slide can carry its own accent colour, a call-to-action line, a video instead of the
 * picture, an "ends in …" countdown (promo / scheduled slide) and a weight (1–3: how often it
 * comes round). The rotation can be shuffled; it reshuffles only when the list itself changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  adsGridSize,
  formatMoney,
  type ClientAdItem,
  type ClientAdsStyle,
  type ClientDisplayConfig,
} from '@likapcs/shared';
import { formatHMS } from './lib/protocol';
import { t as translate, type Language } from './lib/i18n';
import { buildPages, chunk } from './lib/ads-pages';

/** "Ends in 02:13:45" (or "3d 02:13:45") for a promo / scheduled slide; hidden once over. */
function EndsIn({ endsAt, language }: { endsAt: string; language: Language }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.round((Date.parse(endsAt) - now) / 1000);
  if (!Number.isFinite(left) || left <= 0) return null;
  const days = Math.floor(left / 86400);
  const text =
    days > 0
      ? `${days}${translate(language, 'dayShort')} ${formatHMS(left - days * 86400)}`
      : formatHMS(left);
  return (
    <span className={`ads__ends ${left <= 3600 ? 'ads__ends--soon' : ''}`} data-testid="ad-ends">
      <i aria-hidden />
      {translate(language, 'adsEndsIn')} {text}
    </span>
  );
}

export function AdsSlideshow({
  items,
  display,
  language,
  station,
}: {
  items: ClientAdItem[];
  display: ClientDisplayConfig;
  language: Language;
  station: { code: string; name: string } | null;
}) {
  const {
    layout,
    transition,
    intervalSeconds,
    showPrice,
    fullscreen,
    showStation,
    showCategory,
    showProgress,
    imageFit,
    caption,
    motion,
    shuffle,
    promoCountdown,
  } = display.ads;
  // `full` ("big photo", pre-0.10.0) keeps meaning edge-to-edge pictures: its default style is the
  // poster; ads that carry their own style still win.
  const defaultStyle: ClientAdsStyle = layout === 'full' ? 'poster' : (display.ads.style ?? 'hero');
  const grid = adsGridSize(display.ads.grid);
  const perPage = layout === 'grid' ? grid.cols * grid.rows : 1;
  // A board row is one line of text: more fit than picture cells (2×2 → 10, 3×3 → 18, 4×4 → 32).
  const boardPerPage = grid.cols * Math.max(5, grid.rows * 2);
  // One shuffle per list (ids + order); the rotation stays put across refreshes with no change.
  const listKey = items.map((i) => `${i.id}:${i.weight}`).join('|');
  const seed = useMemo(() => Math.floor(Math.random() * 2 ** 31), [listKey]); // eslint-disable-line react-hooks/exhaustive-deps -- reseed only when the list changes
  const pagesList = useMemo(
    () => buildPages(items, layout, perPage, boardPerPage, shuffle, seed),
    [items, layout, perPage, boardPerPage, shuffle, seed],
  );
  const pages = Math.max(1, pagesList.length);
  const [page, setPage] = useState(0);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  // Pictures that failed to load (server unreachable, file gone): the slide is shown as a text
  // slide instead of being skipped — a screen must never stay empty because of one picture.
  const [broken, setBroken] = useState<Record<string, true>>({});
  // Video lengths once known: a video slide stays for its own length (3–120 s) unless the ad
  // sets a duration.
  const [videoSeconds, setVideoSeconds] = useState<Record<string, number>>({});
  const [layers, setLayers] = useState<{ a: number | null; b: number | null; front: 'a' | 'b' }>({
    a: 0,
    b: null,
    front: 'a',
  });
  // The station pill repeats the PC code only when it is not already the lock title (never
  // twice) and only when the owner wants it; over a grid it gets its own band above the frames.
  const showPill =
    showStation &&
    station !== null &&
    !(display.lockTitle === 'station' && display.ads.showBrand && !fullscreen);
  const frameClass = [
    'ads',
    `ads--${layout}`,
    fullscreen ? 'ads--fullscreen' : '',
    `ads--fit-${imageFit}`,
    `ads--caption-${caption}`,
    motion ? 'ads--motion' : '',
    showPill ? 'ads--pill' : '',
    showProgress && pages > 1 ? 'ads--paged' : '',
  ]
    .filter(Boolean)
    .join(' ');
  // Dense grids get smaller type and tighter gaps so 16 products still read well on 1080p. In
  // full-screen mode the pictures also keep clear of whatever overlays the owner left on.
  const headerPx = display.ads.showBrand || display.ads.showClock ? 100 : 28;
  const insetTop = fullscreen ? headerPx + (showPill ? 58 : 0) : 0;
  const insetBottom = fullscreen
    ? 24 +
      (display.ads.showStatus ? 70 : 0) +
      (display.ads.tickerText.trim() ? 58 : 0) +
      (showProgress ? 24 : 0)
    : 0;
  const gridStyle = {
    '--cols': grid.cols,
    '--rows': grid.rows,
    '--cell-scale': grid.cols >= 4 ? 0.68 : grid.cols === 3 ? 0.82 : 1,
    '--inset-top': `${insetTop}px`,
    '--inset-bottom': `${insetBottom}px`,
    '--pill-top': `${headerPx}px`,
  } as CSSProperties;

  // Preload every picture once; a slide only becomes eligible when all of its pictures decoded.
  // Text-only slides and video slides (the video streams in; the picture is its poster) are
  // ready at once.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const item of items) {
      const url = item.imageUrl;
      if (!url || item.videoUrl) {
        setReady((r) => (r[item.id] === true ? r : { ...r, [item.id]: true }));
        if (!url) continue;
      }
      if (requested.current.has(url)) continue;
      requested.current.add(url);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        setBroken((b) => {
          if (!b[item.id]) return b;
          const next = { ...b };
          delete next[item.id];
          return next;
        });
        setReady((r) => ({ ...r, [item.id]: true }));
      };
      img.onerror = () => {
        requested.current.delete(url); // retried on the next list refresh
        setBroken((b) => ({ ...b, [item.id]: true }));
        setReady((r) => ({ ...r, [item.id]: true }));
      };
      img.src = url;
    }
  }, [items]);
  const pictureOf = (item: ClientAdItem) => (broken[item.id] ? null : item.imageUrl);

  const pageAt = useCallback((index: number) => pagesList[index] ?? null, [pagesList]);
  // A new page sequence (layout, grid, shuffle or list changed) restarts from the first page.
  useEffect(() => {
    setPage(0);
  }, [perPage, layout, listKey, shuffle]);
  const pageReady = useCallback(
    (index: number) => {
      const p = pageAt(index);
      return p !== null && p.items.length > 0 && p.items.every((item) => ready[item.id] === true);
    },
    [pageAt, ready],
  );

  // Advance after the current page's own time (the longest `durationSeconds` on it, a video's
  // length, else the owner's interval; boards get a little longer) — only onto a decoded page.
  const pageSeconds = useCallback(
    (index: number) => {
      const p = pageAt(index);
      if (!p) return Math.max(3, intervalSeconds);
      const own = p.items
        .map((item) => item.durationSeconds ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      if (own > 0) return Math.max(3, own);
      if (p.kind === 'slide' && p.item.videoUrl && videoSeconds[p.item.id])
        return Math.min(120, Math.max(3, Math.ceil(videoSeconds[p.item.id]!)));
      if (p.kind === 'board') return Math.max(8, intervalSeconds);
      return Math.max(3, intervalSeconds);
    },
    [pageAt, intervalSeconds, videoSeconds],
  );
  useEffect(() => {
    if (pages <= 1) return;
    const timer = window.setTimeout(
      () => {
        setPage((current) => {
          for (let step = 1; step <= pages; step += 1) {
            const candidate = (current + step) % pages;
            if (pageReady(candidate)) return candidate;
          }
          return current;
        });
      },
      pageSeconds(page) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [page, pages, pageSeconds, pageReady]);

  // The current page is not decoded yet (start-up, or its picture failed): jump to the first
  // page that is, so the very first frame shown is a complete one.
  const currentReady = pageReady(page);
  useEffect(() => {
    if (currentReady) return;
    for (let i = 0; i < pages; i += 1) {
      if (pageReady(i)) {
        if (i !== page) setPage(i);
        return;
      }
    }
  }, [currentReady, pages, pageReady, page]);

  // Two-layer crossfade: a *ready* incoming page is mounted on the back layer, then brought to
  // the front; the old one slides / fades out underneath and is unmounted on the next change.
  useEffect(() => {
    if (!currentReady) return;
    setLayers((l) => {
      const frontIndex = l.front === 'a' ? l.a : l.b;
      if (frontIndex === page) return l;
      return l.front === 'a' ? { ...l, b: page, front: 'b' } : { ...l, a: page, front: 'a' };
    });
  }, [page, currentReady]);

  const frontIndex = layers.front === 'a' ? layers.a : layers.b;
  if (frontIndex === null || !pageReady(frontIndex)) {
    return (
      <div className={frameClass} data-testid="ads" data-state="loading" style={gridStyle}>
        {showPill && (
          <div className="ads__station">
            <span className="ads__code">{station.code}</span>
          </div>
        )}
      </div>
    );
  }

  const money = (cents: number) =>
    formatMoney(cents, { currency: display.currency, locale: language });
  /** Price block: promo = crossed-out regular + new price; plain otherwise; nothing for slides. */
  const price = (item: ClientAdItem) =>
    showPrice && item.priceCents !== null ? (
      <span className={`ads__pricing ${item.oldPriceCents !== null ? 'ads__pricing--promo' : ''}`}>
        {item.oldPriceCents !== null && <s className="ads__old">{money(item.oldPriceCents)}</s>}
        <span className="ads__price">{money(item.priceCents)}</span>
      </span>
    ) : null;
  const badge = (item: ClientAdItem) =>
    item.badge ? <span className="ads__badge">{item.badge}</span> : null;
  const ends = (item: ClientAdItem) =>
    promoCountdown && item.endsAt ? <EndsIn endsAt={item.endsAt} language={language} /> : null;
  const themeClass = (item: ClientAdItem) => `ads__theme--${item.theme ?? 'midnight'}`;
  const accentStyle = (item: ClientAdItem) =>
    item.accent ? ({ '--ad-accent': item.accent } as CSSProperties) : undefined;
  /** Picture or video of a slide (null → text slide). */
  const media = (item: ClientAdItem, className?: string) => {
    if (item.videoUrl)
      return (
        <video
          className={`ads__video ${className ?? ''}`}
          src={item.videoUrl}
          poster={pictureOf(item) ?? undefined}
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          onLoadedMetadata={(e) => {
            const seconds = e.currentTarget.duration;
            if (Number.isFinite(seconds) && seconds > 0)
              setVideoSeconds((v) => (v[item.id] === seconds ? v : { ...v, [item.id]: seconds }));
          }}
        />
      );
    const url = pictureOf(item);
    return url ? (
      <img className={className} src={url} alt="" draggable={false} />
    ) : (
      <div className={`ads__blank ${className ?? ''}`} aria-hidden />
    );
  };
  const hasMedia = (item: ClientAdItem) => Boolean(item.videoUrl || pictureOf(item));

  const renderSlide = (item: ClientAdItem) => {
    const style: ClientAdsStyle = item.style ?? defaultStyle;
    const text = !hasMedia(item);
    const hideCaption = style === 'poster' && caption === 'hidden' && !text;
    return (
      <figure
        key={item.id}
        className={[
          'ads__slide',
          `ads__slide--${style}`,
          text ? 'ads__slide--text' : '',
          themeClass(item),
        ]
          .filter(Boolean)
          .join(' ')}
        data-kind={item.kind}
        data-theme={item.theme ?? 'midnight'}
        data-style={style}
        data-layout={layout}
        style={accentStyle(item)}
      >
        {style === 'banner' && hasMedia(item) && (
          <div className="ads__backdrop" aria-hidden>
            {pictureOf(item) && <img src={pictureOf(item)!} alt="" draggable={false} />}
          </div>
        )}
        <div className="ads__media">{media(item)}</div>
        {badge(item)}
        {!hideCaption && (
          <figcaption>
            {showCategory && item.categoryName && (
              <span className="ads__cat">{item.categoryName}</span>
            )}
            <span className="ads__name">{item.name}</span>
            {item.body && <span className="ads__body">{item.body}</span>}
            <span className="ads__offer">
              {price(item)}
              {ends(item)}
            </span>
            {item.cta && <span className="ads__cta">{item.cta}</span>}
          </figcaption>
        )}
      </figure>
    );
  };

  const renderGrid = (slice: ClientAdItem[]) => (
    <div className="ads__grid">
      {slice.map((item) => (
        <figure
          key={item.id}
          className={`ads__cell ${hasMedia(item) ? '' : 'ads__cell--text'} ${themeClass(item)}`}
          data-kind={item.kind}
          data-theme={item.theme ?? 'midnight'}
          style={accentStyle(item)}
        >
          {media(item)}
          {badge(item)}
          <figcaption>
            {showCategory && item.categoryName && perPage <= 9 && (
              <span className="ads__cat">{item.categoryName}</span>
            )}
            <span className="ads__name">{item.name}</span>
            {item.body && perPage <= 6 && <span className="ads__body">{item.body}</span>}
            {price(item)}
            {perPage <= 6 && ends(item)}
          </figcaption>
        </figure>
      ))}
    </div>
  );

  const renderBoard = (slice: ClientAdItem[]) => {
    const rows = Math.ceil(slice.length / grid.cols);
    const columns = chunk(slice, Math.max(1, rows));
    return (
      <div className="ads__board" data-testid="ads-board">
        <header className="ads__board-head">
          <span className="ads__board-title">{translate(language, 'adsMenuTitle')}</span>
          {station && showStation && <span className="ads__board-code">{station.code}</span>}
        </header>
        <div
          className="ads__board-cols"
          style={{ '--board-cols': columns.length } as CSSProperties}
        >
          {columns.map((col, ci) => (
            <ul key={ci} className="ads__board-col">
              {col.map((item) => (
                <li
                  key={item.id}
                  className={`ads__row ${item.oldPriceCents !== null ? 'ads__row--promo' : ''}`}
                  data-kind={item.kind}
                  style={accentStyle(item)}
                >
                  {pictureOf(item) && (
                    <img
                      className="ads__row-thumb"
                      src={pictureOf(item)!}
                      alt=""
                      draggable={false}
                    />
                  )}
                  <span className="ads__row-text">
                    <span className="ads__row-name">
                      {item.name}
                      {item.badge && <em className="ads__row-badge">{item.badge}</em>}
                    </span>
                    {(item.body || (showCategory && item.categoryName)) && (
                      <small>{item.body ?? item.categoryName}</small>
                    )}
                  </span>
                  <i className="ads__row-dots" aria-hidden />
                  <span className="ads__row-price">
                    {item.oldPriceCents !== null && (
                      <s className="ads__old">{money(item.oldPriceCents)}</s>
                    )}
                    <b>{money(item.priceCents ?? 0)}</b>
                  </span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
    );
  };

  const renderPage = (index: number | null, key: 'a' | 'b') => {
    if (index === null) return null;
    const p = pageAt(index);
    if (!p) return null;
    const front = layers.front === key;
    return (
      <div
        key={key}
        className={`ads__layer ads__layer--${transition} ${front ? 'is-front' : 'is-back'}`}
        aria-hidden={!front}
        data-page-kind={p.kind}
        onAnimationEnd={(e) => {
          // The incoming slide has fully covered the old one → drop the old layer entirely, so
          // nothing can ever bleed through (and the GPU keeps exactly one picture to composite).
          if (!front || e.target !== e.currentTarget) return;
          setLayers((l) => (l.front === 'a' ? { ...l, b: null } : { ...l, a: null }));
        }}
      >
        {p.kind === 'grid'
          ? renderGrid(p.items)
          : p.kind === 'board'
            ? renderBoard(p.items)
            : renderSlide(p.item)}
      </div>
    );
  };

  const current = pageAt(page);
  return (
    <div
      className={frameClass}
      data-testid="ads"
      data-state="ready"
      data-page={page}
      data-pages={pages}
      data-per-page={current?.kind === 'board' ? boardPerPage : perPage}
      data-page-kind={current?.kind ?? 'slide'}
      style={gridStyle}
    >
      {renderPage(layers.a, 'a')}
      {renderPage(layers.b, 'b')}
      {showPill && (
        <div className="ads__station">
          <span className="ads__code">{station.code}</span>
        </div>
      )}
      {showProgress && pages > 1 && (
        <>
          <div className="ads__dots" aria-hidden>
            {Array.from({ length: Math.min(pages, 12) }, (_, i) => (
              <i key={i} className={i === page % 12 ? 'is-on' : ''} />
            ))}
          </div>
          {/* Thin bar filling over the page's own time; re-keyed per page so it restarts. */}
          <div className="ads__progress" aria-hidden data-testid="ads-progress">
            <i key={page} style={{ animationDuration: `${pageSeconds(page)}s` }} />
          </div>
        </>
      )}
    </div>
  );
}
