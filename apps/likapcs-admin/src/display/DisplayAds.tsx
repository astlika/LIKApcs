/**
 * Ads on the customer display (0.16.0). Plays the same program as a PC — `planAlbums` /
 * `buildProgram` from the shared package: album after album, each with its layout (single
 * slides, product grid, price board), interval, shuffle and the per-slide duration / weight.
 *
 * What is different from the lock screen is the *canvas*: the counter monitor may be small and
 * may stand upright, so the composition follows the viewport —
 *  - single slides put the picture beside the text in landscape and above it in portrait;
 *  - grid pages swap columns and rows when the screen is taller than wide (3×2 → 2×3);
 *  - price boards use two columns only when there is room for them;
 *  - all type and spacing scale with `vmin` (display.css).
 * Pictures are decoded before a page is shown and two layers cross-fade, so there is never an
 * empty frame.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  buildProgram,
  formatMoney,
  planAlbums,
  type AdsPage,
  type AlbumPlan,
  type ClientAdItem,
  type CustomerDisplayFeed,
} from '@likapcs/shared';
import { THEME_COLORS, THEME_GLOWS } from '../lib/ad-themes';
import { fileUrl } from '../lib/api';
import type { Viewport } from './DisplayApp';
import { displayText, type DisplayLanguage } from './i18n';

const MIN_SECONDS = 3;
const PRELOAD_TIMEOUT_MS = 2500;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pageSeconds(page: AdsPage): number {
  const own = page.kind === 'slide' ? page.item.durationSeconds : null;
  return Math.max(MIN_SECONDS, own ?? page.album.intervalSeconds);
}

function mediaOf(item: ClientAdItem): { image: string | null; video: string | null } {
  const video = item.videoUrl ? (fileUrl(item.videoUrl) ?? item.videoUrl) : null;
  return { image: fileUrl(item.imageUrl), video };
}

function preload(url: string | null): Promise<void> {
  if (!url) return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image();
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, PRELOAD_TIMEOUT_MS);
    img.onload = done;
    img.onerror = done;
    img.src = url;
  });
}

function themeVars(theme: ClientAdItem['theme'], accent: string | null): CSSProperties {
  const [a, b] = THEME_COLORS[theme ?? 'midnight'];
  const [g1, g2] = THEME_GLOWS[theme ?? 'midnight'];
  return {
    '--cd-bg-a': a,
    '--cd-bg-b': b,
    '--cd-glow-a': g1,
    '--cd-glow-b': g2,
    ...(accent ? { '--cd-accent': accent } : {}),
  } as CSSProperties;
}

export function DisplayAds({
  feed,
  viewport,
  language,
  currency,
  businessName,
  clock,
}: {
  feed: CustomerDisplayFeed;
  viewport: Viewport;
  language: DisplayLanguage;
  currency: string;
  businessName: string;
  clock: string;
}) {
  const { albums, items } = feed.feed;
  const ads = feed.ads;
  const plans = useMemo(() => planAlbums(albums, items, ads), [albums, items, ads]);
  const listKey = plans.map((p) => `${p.key}:${p.items.map((i) => i.id).join(',')}`).join('|');
  const program = useMemo(() => buildProgram(plans, hashString(listKey)), [plans, listKey]);
  const programRef = useRef(program);
  programRef.current = program;

  // Two layers cross-fade; `front` says which one is visible.
  const [layers, setLayers] = useState<[AdsPage | null, AdsPage | null]>([
    program[0] ?? null,
    null,
  ]);
  const [front, setFront] = useState<0 | 1>(0);
  const indexRef = useRef(0);
  const [tick, setTick] = useState(0);

  // A new program (feed changed): restart from its first page when the current one is gone.
  useEffect(() => {
    const current = layers[front];
    const at = current ? program.findIndex((p) => p.key === current.key) : -1;
    if (at >= 0) {
      indexRef.current = at;
      return;
    }
    indexRef.current = 0;
    setLayers((prev) => {
      const next: [AdsPage | null, AdsPage | null] = [...prev];
      next[front] = program[0] ?? null;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the program only
  }, [program]);

  // Advance after the page's own time; the next page is decoded before it comes to the front.
  useEffect(() => {
    const current = layers[front];
    if (!current || program.length < 2) return;
    let cancelled = false;
    const timer = window.setTimeout(
      async () => {
        const list = programRef.current;
        const nextIndex = (indexRef.current + 1) % list.length;
        const next = list[nextIndex]!;
        const first = next.kind === 'slide' ? next.item : next.items[0];
        await preload(first ? mediaOf(first).image : null);
        if (cancelled) return;
        indexRef.current = nextIndex;
        const back: 0 | 1 = front === 0 ? 1 : 0;
        setLayers((prev) => {
          const copy: [AdsPage | null, AdsPage | null] = [...prev];
          copy[back] = next;
          return copy;
        });
        setFront(back);
        setTick((n) => n + 1);
      },
      pageSeconds(current) * 1000,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [layers, front, program.length]);

  const current = layers[front];
  const money = (cents: number) => formatMoney(cents, { currency, locale: language });
  // Cross-fade, zoom or a sideways slide — the PC's other transitions map onto these three.
  const transition =
    ads.transition === 'zoom' ? 'zoom' : ads.transition.startsWith('slide') ? 'slide' : 'fade';

  return (
    <div
      className={`cd-ads cd-ads--${transition} cd-ads--${viewport.orientation}`}
      data-testid="display-ads"
      data-page={current?.key ?? ''}
      data-page-kind={current?.kind ?? ''}
    >
      {layers.map((page, i) => (
        <div
          key={i}
          className={`cd-ads__layer ${i === front ? 'cd-ads__layer--front' : ''}`}
          aria-hidden={i !== front}
        >
          {page && (
            <Page
              page={page}
              viewport={viewport}
              money={money}
              language={language}
              showPrice={ads.showPrice}
              promoCountdown={ads.promoCountdown}
            />
          )}
        </div>
      ))}
      <div className="cd-ads__chrome">
        {ads.showBrand && <span className="cd-ads__brand">{businessName}</span>}
        {ads.showClock && <span className="cd-ads__clock">{clock}</span>}
      </div>
      {ads.showProgress && current && program.length > 1 && (
        <span
          key={`${current.key}-${tick}`}
          className="cd-ads__progress"
          style={{ animationDuration: `${pageSeconds(current)}s` }}
          aria-hidden
        />
      )}
      {ads.tickerText && (
        <div className="cd-ads__ticker" aria-hidden>
          <span>{ads.tickerText}</span>
          <span>{ads.tickerText}</span>
        </div>
      )}
    </div>
  );
}

// ─── Pages ──────────────────────────────────────────────────────────────────────
function Page({
  page,
  viewport,
  money,
  language,
  showPrice,
  promoCountdown,
}: {
  page: AdsPage;
  viewport: Viewport;
  money: (cents: number) => string;
  language: DisplayLanguage;
  showPrice: boolean;
  promoCountdown: boolean;
}) {
  if (page.kind === 'grid')
    return <GridPage page={page} viewport={viewport} money={money} showPrice={showPrice} />;
  if (page.kind === 'board') return <BoardPage page={page} viewport={viewport} money={money} />;
  return (
    <SlidePage
      item={page.item}
      album={page.album}
      money={money}
      language={language}
      showPrice={showPrice}
      promoCountdown={promoCountdown}
    />
  );
}

function Price({
  item,
  money,
  size,
}: {
  item: ClientAdItem;
  money: (cents: number) => string;
  size: 'big' | 'small';
}) {
  if (item.priceCents === null) return null;
  return (
    <span
      className={`cd-price cd-price--${size} ${item.oldPriceCents !== null ? 'cd-price--promo' : ''}`}
    >
      {item.oldPriceCents !== null && <s>{money(item.oldPriceCents)}</s>}
      <b>{money(item.priceCents)}</b>
    </span>
  );
}

function EndsIn({ endsAt, language }: { endsAt: string; language: DisplayLanguage }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.round((Date.parse(endsAt) - now) / 1000);
  if (!Number.isFinite(left) || left <= 0) return null;
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return (
    <span className="cd-ends">
      {displayText(language, 'endsIn')} {d > 0 ? `${d}d ${hms}` : hms}
    </span>
  );
}

function SlidePage({
  item,
  album,
  money,
  language,
  showPrice,
  promoCountdown,
}: {
  item: ClientAdItem;
  album: AlbumPlan;
  money: (cents: number) => string;
  language: DisplayLanguage;
  showPrice: boolean;
  promoCountdown: boolean;
}) {
  const style = item.style ?? album.style;
  const { image, video } = mediaOf(item);
  const hasMedia = !!(image || video);
  const media = video ? (
    <video className="cd-slide__media" src={video} muted autoPlay loop playsInline />
  ) : image ? (
    <img className="cd-slide__media" src={image} alt="" draggable={false} />
  ) : null;
  return (
    <section
      className={`cd-slide cd-slide--${style} cd-slide--fit-${album.imageFit} ${hasMedia ? '' : 'cd-slide--text'}`}
      style={themeVars(item.theme, item.accent)}
      data-testid="display-slide"
      data-style={style}
    >
      <div className="cd-slide__glow" aria-hidden />
      {hasMedia && <div className="cd-slide__picture">{media}</div>}
      <div className="cd-slide__text">
        {item.badge && <span className="cd-badge">{item.badge}</span>}
        <h2 className="cd-slide__name">{item.name}</h2>
        {item.body && <p className="cd-slide__body">{item.body}</p>}
        {showPrice && <Price item={item} money={money} size="big" />}
        {item.cta && <span className="cd-slide__cta">{item.cta}</span>}
        {promoCountdown && item.endsAt && <EndsIn endsAt={item.endsAt} language={language} />}
      </div>
    </section>
  );
}

function GridPage({
  page,
  viewport,
  money,
  showPrice,
}: {
  page: Extract<AdsPage, { kind: 'grid' }>;
  viewport: Viewport;
  money: (cents: number) => string;
  showPrice: boolean;
}) {
  const { cols, rows } = page.album.grid;
  // Upright screen: the same number of cells, columns and rows swapped.
  const portrait = viewport.orientation === 'portrait';
  const c = portrait ? Math.min(cols, rows) : Math.max(cols, rows);
  const r = portrait ? Math.max(cols, rows) : Math.min(cols, rows);
  return (
    <section
      className={`cd-grid cd-grid--fit-${page.album.imageFit}`}
      style={{ '--cd-cols': c, '--cd-rows': r } as CSSProperties}
      data-testid="display-grid"
      data-cols={c}
      data-rows={r}
    >
      {page.album.name && <h3 className="cd-grid__title">{page.album.name}</h3>}
      <div className="cd-grid__cells">
        {page.items.map((item) => {
          const { image } = mediaOf(item);
          return (
            <article key={item.id} className="cd-cell" style={themeVars(item.theme, item.accent)}>
              <span className="cd-cell__photo">
                {image ? (
                  <img src={image} alt="" draggable={false} />
                ) : (
                  <span className="cd-cell__initial">{item.name.slice(0, 1).toUpperCase()}</span>
                )}
                {item.badge && <span className="cd-badge cd-badge--corner">{item.badge}</span>}
              </span>
              <span className="cd-cell__name">{item.name}</span>
              {showPrice && <Price item={item} money={money} size="small" />}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function BoardPage({
  page,
  viewport,
  money,
}: {
  page: Extract<AdsPage, { kind: 'board' }>;
  viewport: Viewport;
  money: (cents: number) => string;
}) {
  const twoColumns = viewport.orientation === 'landscape' && page.items.length >= 8;
  return (
    <section
      className={`cd-board ${twoColumns ? 'cd-board--two' : ''}`}
      style={themeVars(page.items[0]?.theme ?? null, null)}
      data-testid="display-board"
    >
      <div className="cd-slide__glow" aria-hidden />
      {page.album.name && <h3 className="cd-board__title">{page.album.name}</h3>}
      <ul className="cd-board__list">
        {page.items.map((item) => (
          <li key={item.id} className="cd-board__row">
            <span className="cd-board__name">
              {item.name}
              {item.badge && <span className="cd-badge cd-badge--inline">{item.badge}</span>}
            </span>
            <span className="cd-board__dots" aria-hidden />
            <Price item={item} money={money} size="small" />
          </li>
        ))}
      </ul>
    </section>
  );
}
