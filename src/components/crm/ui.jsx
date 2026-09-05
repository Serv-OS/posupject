// The design system for projects and tasks, as components.
//
// Every value here is lifted from the spec's artboards: sizes, radii, weights,
// the chip tint ratios (.12 fill / .28 border / -deep text). Screens compose
// these and add layout; they do not restate the numbers. That is what keeps
// eleven screens looking like one product, and it is the only way the same
// markup can re-theme across four CRM instances from tokens alone.

import { PRIORITY_LABEL } from '../../lib/priority';

// ── Colour by person ─────────────────────────────────────────────────────────
// The spec colours avatars per person (Peter primary, Sarah uv, James amber)
// so a glance across a list tells you who is on what. Stable across screens
// because it hashes the id, never the position in a list.
const AVATAR_TONES = [
  { bg: 'rgb(var(--c-primary))', fg: 'rgb(var(--c-ink))' },
  { bg: 'rgb(var(--c-uv))',      fg: 'var(--on-accent)' },
  { bg: 'rgb(var(--c-amber))',   fg: 'rgb(var(--c-ink))' },
  { bg: 'rgb(var(--c-coral))',   fg: 'var(--on-accent)' },
];
export function avatarTone(id) {
  if (!id) return null;
  let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.length === 1 ? parts[0][0].toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** 26px by default; 20 in board cards, 34 on People, 22 in checklists. */
export function Avatar({ id, name, size = 26, className = '', title }) {
  const tone = avatarTone(id);
  const empty = !id;
  return (
    <span title={title ?? name} className={`inline-flex items-center justify-center rounded-full shrink-0 font-bold ${className}`}
      style={{
        width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)),
        background: empty ? 'var(--ink-soft)' : tone.bg,
        color: empty ? 'rgb(var(--c-dim))' : tone.fg,
        border: empty ? '1px solid var(--ink-line)' : 'none',
      }}>
      {empty ? '?' : initialsOf(name)[0]}
    </span>
  );
}

// ── Checkbox ────────────────────────────────────────────────────────────────
// 19px, 6px radius. Done = primary tint + primary border + tick in primary-deep.
// Open = 2px check-bdr. The "active" variant (primary border, no fill) marks
// the task with the timer running or currently in progress.
export function Check({ done, active, size = 19, onClick, disabled, title }) {
  const r = Math.round(size * 0.32);
  const style = done
    ? { background: 'rgb(var(--c-primary) / .16)', border: '2px solid rgb(var(--c-primary))', color: 'rgb(var(--c-primary-deep))' }
    : active
      ? { border: '2px solid rgb(var(--c-primary))' }
      : { border: '2px solid var(--check-bdr)' };
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="shrink-0 flex items-center justify-center transition hover:opacity-80 disabled:cursor-default"
      style={{ width: size, height: size, borderRadius: r, fontSize: Math.round(size * 0.63), lineHeight: 1, ...style }}>
      {done ? '✓' : ''}
    </button>
  );
}

// ── Pills and chips ─────────────────────────────────────────────────────────
// Tint recipe from the spec: rgb(token / .12) fill, / .28 border, -deep text.
const TINT = {
  primary: { bg: 'rgb(var(--c-primary) / .12)', bd: 'rgb(var(--c-primary) / .22)', fg: 'rgb(var(--c-primary-deep))' },
  uv:      { bg: 'rgb(var(--c-uv) / .10)',      bd: 'rgb(var(--c-uv) / .22)',      fg: 'rgb(var(--c-uv-deep))' },
  amber:   { bg: 'rgb(var(--c-amber) / .14)',   bd: 'rgb(var(--c-amber) / .32)',   fg: 'rgb(var(--c-amber-deep))' },
  coral:   { bg: 'rgb(var(--c-coral) / .12)',   bd: 'rgb(var(--c-coral) / .28)',   fg: 'rgb(var(--c-coral-deep))' },
  ink:     { bg: 'var(--ink-soft)',             bd: 'var(--ink-line)',             fg: 'rgb(var(--c-muted))' },
};
export const tint = (k) => TINT[k] || TINT.ink;

/** 10px/700 uppercase .05em, 3px 9px, radius 6 — status and priority. */
export function Pill({ tone = 'ink', children, onClick, caret, className = '', title }) {
  const t = tint(tone);
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} title={title}
      className={`inline-flex items-center gap-1 shrink-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-[.05em] px-[9px] py-[3px] rounded-[6px] border ${onClick ? 'hover:opacity-80' : ''} ${className}`}
      style={{ background: t.bg, borderColor: t.bd, color: t.fg }}>
      {children}{caret && <span className="opacity-70">&#9662;</span>}
    </Tag>
  );
}

export const STATUS_TONE = { todo: 'ink', in_progress: 'amber', blocked: 'coral', done: 'primary' };
export const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
export const STATUS_ORDER = ['todo', 'in_progress', 'blocked', 'done'];
export function StatusPill({ status, onClick, caret = !!onClick }) {
  return <Pill tone={STATUS_TONE[status] || 'ink'} onClick={onClick} caret={caret}>{STATUS_LABEL[status] || status}</Pill>;
}

// Priority by NAME, never P-number: the codes are off by one from the doc.
export const PRIORITY_TONE = { P0: 'coral', P1: 'coral', P2: 'ink', P3: 'ink' };
export function PriorityPill({ priority, onClick }) {
  if (!priority) return null;
  return <Pill tone={PRIORITY_TONE[priority] || 'ink'} onClick={onClick} caret={!!onClick}>{PRIORITY_LABEL[priority] || priority}</Pill>;
}

/** Work-item type chip (screen 13): Ticket coral, Onboarding uv, Approval amber, Task primary, Request ink. */
export const TYPE_TONE = { task: 'primary', ticket: 'coral', onboarding: 'uv', approval: 'amber', request: 'ink' };
export function TypeChip({ type }) {
  return <Pill tone={TYPE_TONE[type] || 'ink'} className="px-[8px]">{type}</Pill>;
}

/** 12px, 3px 9px, radius 7 — linked-record chips in headers (project, ticket, customer). */
export function LinkChip({ tone = 'ink', children, onClick, title }) {
  const t = tint(tone);
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} title={title}
      className={`inline-flex items-center gap-1.5 shrink-0 max-w-full text-[12px] px-[9px] py-[3px] rounded-[7px] border ${onClick ? 'hover:opacity-80 cursor-pointer' : ''}`}
      style={{ background: t.bg, borderColor: t.bd, color: t.fg }}>
      <span className="truncate">{children}</span>
    </Tag>
  );
}

/** 11px, 2px 7px, radius 6 — the small tag inside rows and group headers. */
export function Tag({ tone = 'ink', children, className = '' }) {
  const t = tint(tone);
  return (
    <span className={`inline-flex items-center shrink-0 text-[11px] px-[7px] py-[2px] rounded-[6px] border ${className}`}
      style={{ background: t.bg, borderColor: t.bd, color: t.fg }}>{children}</span>
  );
}

// ── Type ────────────────────────────────────────────────────────────────────
/** 9px mono, .18em, uppercase, dim — the label above every card section. */
export function SectionLabel({ children, tone, className = '' }) {
  const color = tone === 'primary' ? 'rgb(var(--c-primary-deep))' : tone === 'amber' ? 'rgb(var(--c-amber-deep))'
    : tone === 'coral' ? 'rgb(var(--c-coral))' : 'rgb(var(--c-dim))';
  return <div className={`font-mono text-[9px] font-bold tracking-[.18em] uppercase ${className}`} style={{ color }}>{children}</div>;
}
/** 10px variant used for group headers and the page meta line. */
export function MetaLabel({ children, tone, className = '' }) {
  const color = tone === 'primary' ? 'rgb(var(--c-primary-deep))' : tone === 'amber' ? 'rgb(var(--c-amber-deep))'
    : tone === 'coral' ? 'rgb(var(--c-coral))' : tone === 'muted' ? 'rgb(var(--c-muted))' : 'rgb(var(--c-dim))';
  return <span className={`font-mono text-[10px] font-bold tracking-[.18em] uppercase ${className}`} style={{ color }}>{children}</span>;
}
export const Mono = ({ children, tone, className = '', size = 11, bold }) => {
  const color = tone === 'primary' ? 'rgb(var(--c-primary-deep))' : tone === 'coral' ? 'rgb(var(--c-coral))'
    : tone === 'amber' ? 'rgb(var(--c-amber-deep))' : tone === 'muted' ? 'rgb(var(--c-muted))' : 'rgb(var(--c-dim))';
  return <span className={`font-mono ${bold ? 'font-bold' : ''} ${className}`} style={{ fontSize: size, color }}>{children}</span>;
};

/** Page title: display face, 24 on lists, 28 on records. */
export function PageTitle({ children, size = 24, className = '' }) {
  return <h3 className={`font-display font-extrabold text-paper m-0 leading-none ${className}`} style={{ fontSize: size }}>{children}</h3>;
}

// ── Buttons ─────────────────────────────────────────────────────────────────
/** The green one. Gradient, ink text, accent shadow. One per screen. */
export function PrimaryBtn({ children, onClick, disabled, className = '', type = 'button', small }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`inline-flex items-center gap-1.5 shrink-0 rounded-[10px] text-[13px] font-semibold border transition hover:brightness-105 active:brightness-95 disabled:opacity-40 ${small ? 'px-3 py-1.5' : 'px-[15px] py-2'} ${className}`}
      style={{ background: 'linear-gradient(180deg, rgb(var(--c-primary)), rgb(var(--c-primary-deep)))',
        borderColor: 'rgb(var(--c-primary) / .5)', color: 'rgb(var(--c-ink))', boxShadow: 'var(--shadow-accent)' }}>
      {children}
    </button>
  );
}
/** Panel background, bdr border, text-soft. */
export function GhostBtn({ children, onClick, disabled, className = '', type = 'button', title, active }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className={`inline-flex items-center gap-1.5 shrink-0 rounded-[10px] text-[13px] border transition hover:brightness-[.98] disabled:opacity-40 px-[13px] py-2 ${className}`}
      style={active
        ? { background: 'rgb(var(--c-primary) / .12)', borderColor: 'rgb(var(--c-primary) / .30)', color: 'rgb(var(--c-primary-deep))', fontWeight: 600 }
        : { background: 'var(--panel-bg)', borderColor: 'var(--bdr)', color: 'rgb(var(--c-text-soft))' }}>
      {children}
    </button>
  );
}
/** Small solid chip-button used in "Add to project" / "Add" rows. */
export function SolidChipBtn({ children, onClick, disabled, title }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="text-[12px] px-[11px] py-[5px] rounded-[8px] border transition hover:border-ember/40 disabled:opacity-40"
      style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)', color: 'rgb(var(--c-text-soft))' }}>
      {children}
    </button>
  );
}

/** Filter pill: panel by default, primary tint when on, coral tint for "behind". */
export function FilterPill({ children, on, tone = 'primary', onClick, className = '' }) {
  const t = tint(tone);
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1.5 shrink-0 text-[13px] px-3 py-[7px] rounded-[10px] border transition ${className}`}
      style={on ? { background: t.bg, borderColor: t.bd, color: t.fg, fontWeight: 600 }
        : { background: 'var(--panel-bg)', borderColor: 'var(--bdr)', color: 'rgb(var(--c-muted))' }}>
      {children}
    </button>
  );
}

/** "Group: Project" style control — label then a bold value, opens a menu. */
export function LabelledPill({ label, value, onClick, className = '' }) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1.5 shrink-0 text-[13px] px-3 py-[7px] rounded-[10px] border transition hover:border-ember/40 ${className}`}
      style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)', color: 'rgb(var(--c-text))' }}>
      <span className="text-muted">{label}</span> <strong className="font-semibold">{value}</strong>
    </button>
  );
}

/** Segmented control: ink-soft track, surface-solid active with tile shadow. */
export function Segmented({ value, options, onChange }) {
  return (
    <div className="inline-flex p-[3px] rounded-[10px] gap-[2px] shrink-0" style={{ background: 'var(--ink-soft)' }}>
      {options.map(([k, label]) => (
        <button key={k} type="button" onClick={() => onChange(k)}
          className="px-3 py-1.5 rounded-[8px] text-[13px] transition"
          style={value === k
            ? { background: 'var(--surface-solid)', fontWeight: 600, boxShadow: 'var(--shadow-tile)', color: 'rgb(var(--c-text))' }
            : { color: 'rgb(var(--c-muted))' }}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** The lens pills on Today: active is solid INK, not brand. */
export function LensPill({ on, children, count, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex items-center gap-1.5 shrink-0 text-[13px] font-semibold px-[14px] py-[7px] rounded-full border transition"
      style={on ? { background: 'rgb(var(--c-text))', color: 'var(--on-accent)', borderColor: 'transparent' }
        : { background: 'var(--panel-bg)', borderColor: 'var(--bdr)', color: 'rgb(var(--c-text-soft))', fontWeight: 400 }}>
      {children}{count != null && <Mono className="ml-0.5" tone={on ? undefined : 'dim'}>{count}</Mono>}
    </button>
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────────
/** The card: card-bg, bdr, 16 radius, shadow-card. `panel` swaps to panel-bg with no shadow. */
export function Card({ children, className = '', panel, style, onClick, coral }) {
  return (
    /* shrink-0: overflow-hidden zeroes a flex item's automatic minimum size, so
       inside a flex-column scroller a Card would be squashed and clip its rows. */
    <div onClick={onClick} className={`rounded-[16px] border overflow-hidden shrink-0 ${onClick ? 'cursor-pointer' : ''} ${className}`}
      style={{ background: panel ? 'var(--panel-bg)' : 'var(--card-bg)',
        borderColor: coral ? 'rgb(var(--c-coral) / .28)' : 'var(--bdr)',
        boxShadow: panel ? 'none' : 'var(--shadow-card)', ...style }}>
      {children}
    </div>
  );
}
/** 12px 16px header row with a hairline under it. */
export function CardHead({ children, className = '' }) {
  return <div className={`px-4 py-3 flex items-center gap-2.5 border-b ${className}`} style={{ borderColor: 'var(--hair)' }}>{children}</div>;
}
export const hair = { borderColor: 'var(--hair)' };

/** Dashed add row: surface-solid, dashed dash-line, 12 radius, 11px 14px. */
export function DashedAdd({ children, onClick, trailing, className = '' }) {
  return (
    <div onClick={onClick}
      className={`flex items-center gap-2.5 px-[14px] py-[11px] rounded-[12px] border border-dashed cursor-text ${className}`}
      style={{ background: 'var(--surface-solid)', borderColor: 'var(--dash-line)' }}>
      <span className="text-[18px] leading-none text-dim">+</span>
      <span className="flex-1 min-w-0 text-[14px] text-dim">{children}</span>
      {trailing}
    </div>
  );
}

/** The one multi-select UI: a dark floating bar. */
export function DarkBar({ count, actions, onClear }) {
  return (
    <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-[18px] py-[9px] sm:py-[11px] rounded-[14px] overflow-x-auto [scrollbar-width:none]"
      style={{ background: 'rgb(var(--c-text))', color: 'var(--on-accent)', boxShadow: 'var(--shadow-pop)' }}>
      <span className="text-[13px] font-semibold shrink-0">{count}<span className="hidden sm:inline"> selected</span></span>
      <span className="w-px h-[18px] shrink-0" style={{ background: 'var(--on-inverse-line)' }} />
      {actions.map(([label, fn, danger]) => (
        <button key={label} type="button" onClick={fn} className="text-[13px] shrink-0 min-h-[36px] px-1 hover:opacity-100 transition"
          style={{ color: danger ? 'rgb(var(--c-coral) / .85)' : 'var(--on-inverse-soft)' }}>{label}</button>
      ))}
      <button type="button" onClick={onClear} className="ml-auto shrink-0 min-h-[36px] px-2 text-[15px]" style={{ color: 'var(--on-inverse-soft)' }}>&times;</button>
    </div>
  );
}

// ── States (screen 10) ──────────────────────────────────────────────────────
/** Skeleton, not a spinner: the shape of what is coming reads as progress. */
export function SkeletonList({ rows = 3, head = true }) {
  const bar = (w, h = 11, r = 4, soft) => <span className="inline-block" style={{ width: w, height: h, borderRadius: r, background: soft ? 'var(--ink-soft)' : 'var(--ink-line)' }} />;
  return (
    <Card>
      {head && <div className="px-4 py-3 flex items-center gap-2.5 border-b" style={hair}>{bar(130)}{bar(70, 9, 4, true)}</div>}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-4 py-[14px] flex items-center gap-3 border-b last:border-b-0" style={hair}>
          {bar(19, 19, 6, true)}<span className="flex-1">{bar('100%', 11, 4, i > 0)}</span>{bar(54, 11, 6, true)}{bar(26, 26, 13, true)}
        </div>
      ))}
    </Card>
  );
}
/** Empty state always offers the next action. */
export function EmptyState({ title, body, primary, secondary, onPrimary, onSecondary }) {
  return (
    <Card className="px-7 py-9 text-center">
      <div className="font-display text-[20px] font-extrabold text-paper">{title}</div>
      {body && <div className="text-[14px] text-muted mx-auto mt-1 mb-[18px] max-w-[440px]">{body}</div>}
      {(primary || secondary) && (
        <div className="flex gap-[9px] justify-center">
          {primary && <PrimaryBtn onClick={onPrimary} className="!px-4 !py-[9px]">{primary}</PrimaryBtn>}
          {secondary && <SolidChipBtn onClick={onSecondary}><span className="text-[13px] font-semibold px-1 py-0.5 inline-block">{secondary}</span></SolidChipBtn>}
        </div>
      )}
    </Card>
  );
}
/** Write failed, work not lost. Optimistic writes everywhere surface here. */
export function ErrorCard({ title = 'Could not save that change', body, onRetry, onDiscard, pending }) {
  return (
    <Card coral className="px-[22px] py-5">
      <div className="text-[16px] font-bold" style={{ color: 'rgb(var(--c-coral-deep))' }}>{title}</div>
      {body && <div className="text-[14px] text-paper-soft mt-1">{body}</div>}
      <div className="flex gap-[9px] items-center mt-3">
        {onRetry && <SolidChipBtn onClick={onRetry}><span className="text-[13px] font-semibold">Retry now</span></SolidChipBtn>}
        {onDiscard && <button type="button" onClick={onDiscard} className="text-[13px] text-muted px-[15px] py-2">Discard change</button>}
        {pending != null && <Mono>Offline · {pending} pending</Mono>}
      </div>
    </Card>
  );
}

// ── Status popover ──────────────────────────────────────────────────────────
// The four-item menu behind every status pill. menu-surface, not glass: a
// popover inside a card cannot rely on backdrop-filter and comes out
// see-through. The digit on each row is the keyboard shortcut (1–4).
import { useEffect as _useEffect, useRef as _useRef } from 'react';
export function StatusMenu({ current, onPick, onClose, align = 'right' }) {
  const ref = _useRef(null);
  _useEffect(() => {
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div ref={ref} className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full mt-1 z-40 min-w-[170px] menu-surface rounded-[10px] py-1`}>
      {STATUS_ORDER.map((s, i) => (
        <button key={s} type="button" onClick={() => onPick(s)}
          className="w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 flex items-center justify-between gap-3">
          <span className={s === current ? 'font-semibold' : ''}>{STATUS_LABEL[s]}</span>
          <Mono size={10}>{i + 1}</Mono>
        </button>
      ))}
    </div>
  );
}

// ── Mobile (screens 11, 15–18) ──────────────────────────────────────────────
/** The docked bar above the tab bar. Same height on every screen, so the thumb
 *  never hunts. Renders a spacer in flow so content can scroll clear of it. */
export function MobileDock({ children }) {
  return (
    <>
      <div className="lg:hidden h-[76px] shrink-0" aria-hidden />
      <div className="lg:hidden fixed inset-x-0 z-30 px-[14px] pt-[10px] pb-[8px]"
        style={{ bottom: 'calc(var(--tabbar-h) + env(safe-area-inset-bottom))', background: 'linear-gradient(180deg, transparent, var(--scene) 30%)' }}>
        {children}
      </div>
    </>
  );
}
/** The docked add field: surface-solid, 14px 16px, radius 14, shadow-card. */
export function DockField({ children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-2.5 px-4 py-[14px] rounded-[14px] border text-left"
      style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)', boxShadow: 'var(--shadow-card)' }}>
      <span className="text-[19px] leading-none text-dim">+</span>
      <span className="text-[15px] text-dim">{children}</span>
    </button>
  );
}
/** Swipe right completes, swipe left opens status. Returns touch handlers and
 *  the live offset so the row can slide under the thumb. Mouse is ignored:
 *  on desktop the checkbox and the pill do these jobs. */
export function useSwipeRow(onRight, onLeft, threshold = 72) {
  const [dx, setDx] = _useState(0);
  const start = _useRef(null);
  const handlers = {
    onTouchStart: (e) => { start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false }; },
    onTouchMove: (e) => {
      if (!start.current) return;
      const ddx = e.touches[0].clientX - start.current.x, ddy = e.touches[0].clientY - start.current.y;
      if (Math.abs(ddy) > Math.abs(ddx)) return;   // a scroll, not a swipe
      start.current.moved = true;
      setDx(Math.max(-120, Math.min(120, ddx)));
    },
    onTouchEnd: () => {
      const d = dx; setDx(0);
      if (!start.current?.moved) return;
      if (d > threshold) onRight?.(); else if (d < -threshold) onLeft?.();
      start.current = null;
    },
  };
  return { dx, handlers };
}
import { useState as _useState } from 'react';

// ── Dates ───────────────────────────────────────────────────────────────────
const dayKey = (d) => { const x = d instanceof Date ? d : new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
/** "Today" / "2 days late" / "12 Sep" / "No date" with a tone the caller can colour by. */
export function dueLabel(due, status, now = new Date()) {
  if (!due) return { text: 'No date', tone: 'dim' };
  const key = String(due).slice(0, 10);
  const today = dayKey(now);
  if (status === 'done') return { text: fmtShort(key), tone: 'dim' };
  if (key === today) return { text: 'Today', tone: 'primary' };
  const t0 = new Date(today + 'T00:00:00'), t1 = new Date(key + 'T00:00:00');
  const days = Math.round((t1 - t0) / 86400000);
  if (days < 0) return { text: `${-days} day${days === -1 ? '' : 's'} late`, tone: 'coral' };
  if (days === 1) return { text: 'Tomorrow', tone: 'muted' };
  if (days < 7) return { text: t1.toLocaleDateString('en-GB', { weekday: 'short' }), tone: 'muted' };
  return { text: fmtShort(key), tone: 'dim' };
}
export function fmtShort(d) { return d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''; }
export function fmtRel(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, (now - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export function fmtHM(seconds) {
  const s = Math.max(0, Math.round(seconds || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// ── Phone patterns (screens 18, 20, 22, 23) ───────────────────────────────

import { isOnline as _isOnline, pending as _pending } from '../../lib/offlineQueue';
import { createPortal as _createPortal } from 'react-dom';

/** Bottom sheet: dims the page, slides a card up from the tab bar. */
export function MobileSheet({ title, sub, onClose, children, footer, tall }) {
  // --app-vh is the VISUAL viewport, so the sheet docks above the on-screen keyboard
  // instead of being laid out behind it against the layout viewport.
  return _createPortal(
    <div className="lg:hidden fixed inset-x-0 top-0 z-[70] flex flex-col justify-end bg-black/40" onClick={onClose} style={{ height: 'var(--app-vh, 100%)' }}>
      <div onClick={e => e.stopPropagation()} className="rounded-t-[20px] border-t flex flex-col"
        style={{ background: 'var(--raised-bg)', borderColor: 'var(--bdr)', boxShadow: 'var(--shadow-pop)', paddingBottom: 'env(safe-area-inset-bottom)',
          [tall ? 'height' : 'maxHeight']: `calc(var(--app-vh, 100vh) * ${tall ? 0.88 : 0.8})` }}>
        <div className="mx-auto mt-2 w-9 h-1 rounded-full" style={{ background: 'var(--ink-line)' }} />
        {(title || sub) && (
          <div className="px-[18px] pt-3 pb-2.5 border-b" style={{ borderColor: 'var(--hair)' }}>
            {title && <div className="text-[15px] font-bold text-paper">{title}</div>}
            {sub && <div className="text-[12px] text-dim">{sub}</div>}
          </div>
        )}
        <div className="px-[14px] py-3 flex flex-col gap-3 [&>*]:shrink-0" style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>{children}</div>
        {footer && <div className="px-[14px] py-3 border-t flex gap-2" style={{ borderColor: 'var(--hair)' }}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A row in a sheet: title, optional sub, optional trailing. Coral tone for destructive. */
export function SheetRow({ children, sub, trailing, onClick, tone, active }) {
  return (
    <button type="button" onClick={onClick} className="w-full min-h-[48px] px-[15px] py-2.5 rounded-[12px] flex items-center gap-2.5 text-left border"
      style={{ background: active ? 'rgb(var(--c-primary) / .10)' : 'var(--surface-solid)', borderColor: active ? 'rgb(var(--c-primary) / .35)' : 'var(--ink-line)' }}>
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] font-medium truncate" style={{ color: tone === 'coral' ? 'rgb(var(--c-coral-deep))' : 'rgb(var(--c-text))' }}>{children}</span>
        {sub && <span className="block text-[12px] text-dim truncate">{sub}</span>}
      </span>
      {trailing}
    </button>
  );
}

/** Amber banner: offline, or writes still waiting to send (18). Draws nothing when all is well. */
export function OfflineBanner({ onView }) {
  const [state, setState] = _useState({ online: _isOnline(), n: _pending().length, failed: _pending().filter(p => p.error).length });
  _useEffect(() => {
    const f = () => setState({ online: _isOnline(), n: _pending().length, failed: _pending().filter(p => p.error).length });
    window.addEventListener('online', f); window.addEventListener('offline', f); window.addEventListener('offline-queue-changed', f);
    return () => { window.removeEventListener('online', f); window.removeEventListener('offline', f); window.removeEventListener('offline-queue-changed', f); };
  }, []);
  if (state.online && state.n === 0) return null;
  const title = !state.online ? `Offline${state.n ? ` — ${state.n} change${state.n === 1 ? '' : 's'} queued` : ''}` : state.failed ? `${state.failed} change${state.failed === 1 ? '' : 's'} could not send` : `Sending ${state.n} queued change${state.n === 1 ? '' : 's'}…`;
  const body = !state.online ? 'They will send when signal returns' : state.failed ? 'Open the Inbox to retry or discard them' : 'Signal is back';
  return (
    <div className="lg:hidden mx-[14px] mt-3 px-[14px] py-[11px] rounded-[12px] flex items-center gap-2.5 border"
      style={{ background: 'rgb(var(--c-amber) / .14)', borderColor: 'rgb(var(--c-amber) / .32)' }}>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold" style={{ color: 'rgb(var(--c-amber-deep))' }}>{title}</div>
        <div className="text-[12px] text-muted">{body}</div>
      </div>
      {onView && <button type="button" onClick={onView} className="text-[12px] font-semibold" style={{ color: 'rgb(var(--c-amber-deep))' }}>View</button>}
    </div>
  );
}

/** Hold to act (pin, select, move). 550ms, cancelled by movement. */
export function useLongPress(onLong, ms = 550) {
  const t = _useRef(null);
  const fired = _useRef(false);
  const clear = () => { if (t.current) { clearTimeout(t.current); t.current = null; } };
  const handlers = (arg) => ({
    onTouchStart: () => { clear(); fired.current = false; t.current = setTimeout(() => { fired.current = true; onLong(arg); if (navigator.vibrate) navigator.vibrate(10); }, ms); },
    onTouchEnd: clear, onTouchMove: clear, onTouchCancel: clear,
    // Swallow the menu the long press triggers; never treat a right-click as a hold.
    onContextMenu: (e) => e.preventDefault(),
    // The click that follows a hold belongs to the hold, not to the row.
    onClickCapture: (e) => { if (fired.current) { fired.current = false; e.preventDefault(); e.stopPropagation(); } },
  });
  handlers.fired = fired;
  return handlers;
}

/**
 * Wide data table on a phone (20): Cards showing the three columns you chose, or the
 * real table with the first column pinned. Long-press a row for selection.
 *
 * columns: [{ key, label, render?(row) → node, align?: 'right', mono?: bool, pinned?: bool }]
 * card:    (row) → { title, amount?, chip?: { text, tone }, meta?: string, tone?: 'coral'|'amber', action?: node }
 */
export function MobileTable({ storageKey, rows, columns, card, onRow, rowKey = (r) => r.id, empty = 'Nothing here yet.', selectable, bulk }) {
  const [mode, setMode] = _useState(() => { try { return localStorage.getItem(`${storageKey}.mode`) || 'cards'; } catch { return 'cards'; } });
  const [chosen, setChosen] = _useState(() => {
    try { const v = JSON.parse(localStorage.getItem(`${storageKey}.cols`) || 'null'); if (Array.isArray(v) && v.length) return v; } catch { /* default below */ }
    return columns.filter(c => !c.pinned).slice(0, 3).map(c => c.key);
  });
  const [chooser, setChooser] = _useState(false);
  const [selected, setSelected] = _useState(() => new Set());
  _useEffect(() => { try { localStorage.setItem(`${storageKey}.mode`, mode); localStorage.setItem(`${storageKey}.cols`, JSON.stringify(chosen)); } catch { /* fine */ } }, [mode, chosen, storageKey]);
  const press = useLongPress((row) => { if (!selectable) return; setSelected(s => { const n = new Set(s); const k = rowKey(row); n.has(k) ? n.delete(k) : n.add(k); return n; }); });
  const pinned = columns.find(c => c.pinned) || columns[0];
  const rest = columns.filter(c => c !== pinned);
  const shown = rest.filter(c => chosen.includes(c.key));
  const toggleCol = (k) => setChosen(c => (c.includes(k) ? c.filter(x => x !== k) : [...c, k]));
  const cell = (c, r) => (c.render ? c.render(r) : r[c.key] ?? '—');
  const toggle = (row) => setSelected(s => { const n = new Set(s); const k = rowKey(row); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const tap = (row) => { if (selected.size) { toggle(row); return; } onRow?.(row); };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Segmented value={mode} options={[['cards', 'Cards'], ['table', 'Table']]} onChange={setMode} />
        <button type="button" onClick={() => setChooser(true)} className="text-[13px] font-semibold" style={{ color: 'rgb(var(--c-primary-deep))' }}>Columns</button>
        {selectable && selected.size > 0 && <Mono className="ml-auto">{selected.size} selected</Mono>}
      </div>
      {rows.length === 0 ? <Card className="px-4 py-6 text-center text-[14px] text-dim">{empty}</Card> : mode === 'cards' ? (
        <Card>
          {rows.map((r, i) => {
            const c = card(r); const k = rowKey(r); const on = selected.has(k);
            return (
              <div key={k} {...press(r)} onClick={() => tap(r)} className={`px-[15px] py-[13px] ${i < rows.length - 1 ? 'border-b' : ''}`}
                style={{ borderColor: 'var(--hair)', borderLeft: c.tone ? `3px solid rgb(var(--c-${c.tone}))` : '3px solid transparent', background: on ? 'rgb(var(--c-primary) / .08)' : undefined }}>
                <div className="flex items-center gap-2">
                  {selectable && selected.size > 0 && <Check done={on} size={18} />}
                  <span className="text-[15px] font-semibold flex-1 min-w-0 truncate text-paper">{c.title}</span>
                  {c.amount != null && <span className="font-mono text-[14px] font-bold text-paper">{c.amount}</span>}
                  {c.action && <span onClick={e => e.stopPropagation()} className="shrink-0">{c.action}</span>}
                </div>
                <div className="flex items-center gap-2 mt-1 min-w-0">
                  {c.chip && <Pill tone={c.chip.tone}>{c.chip.text}</Pill>}
                  {/* The chosen columns ARE the card's second line — that is what makes
                      "Columns" mean something in Cards mode; meta is the fallback. */}
                  <span className="text-[12px] text-muted truncate">{shown.length ? shown.map(col => cell(col, r)).filter(v => v != null && v !== '—').map((v, j) => <span key={j}>{j ? ' · ' : ''}{v}</span>) : c.meta}</span>
                </div>
              </div>
            );
          })}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto [scrollbar-width:thin]">
            <table className="min-w-full text-[13px] border-collapse">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 text-left px-[15px] py-2.5 font-mono text-[9px] font-bold tracking-[.18em] uppercase text-dim border-b" style={{ background: 'var(--card-bg)', borderColor: 'var(--hair)' }}>{pinned.label}</th>
                  {shown.map(c => <th key={c.key} className={`px-3 py-2.5 font-mono text-[9px] font-bold tracking-[.18em] uppercase text-dim border-b whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'}`} style={{ borderColor: 'var(--hair)' }}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const k = rowKey(r); const on = selected.has(k);
                  return (
                    <tr key={k} {...press(r)} onClick={() => tap(r)} style={{ background: on ? 'rgb(var(--c-primary) / .08)' : undefined }}>
                      <td className={`sticky left-0 z-10 px-[15px] py-2.5 font-medium text-paper whitespace-nowrap ${i < rows.length - 1 ? 'border-b' : ''}`} style={{ background: on ? 'rgb(var(--c-primary) / .08)' : 'var(--card-bg)', borderColor: 'var(--hair)' }}>{cell(pinned, r)}</td>
                      {shown.map(c => <td key={c.key} className={`px-3 py-2.5 whitespace-nowrap text-paper-soft ${c.align === 'right' ? 'text-right' : ''} ${c.mono ? 'font-mono' : ''} ${i < rows.length - 1 ? 'border-b' : ''}`} style={{ borderColor: 'var(--hair)' }}>{cell(c, r)}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-[15px] py-2 text-[11px] text-dim border-t" style={{ borderColor: 'var(--hair)' }}>First column pinned, rest scrolls · {selectable ? 'long-press a row to select' : `${rest.length} columns available`}</div>
        </Card>
      )}
      {selectable && selected.size > 0 && bulk && (
        <DarkBar>{bulk([...selected], () => setSelected(new Set()))}</DarkBar>
      )}
      {chooser && (
        <MobileSheet title="Columns" sub={mode === 'cards' ? 'Cards show up to three' : 'Every column of the desktop table'} onClose={() => setChooser(false)}>
          {rest.map(c => (
            <SheetRow key={c.key} active={chosen.includes(c.key)} onClick={() => toggleCol(c.key)} trailing={<Check done={chosen.includes(c.key)} size={18} />}>{c.label}</SheetRow>
          ))}
        </MobileSheet>
      )}
    </div>
  );
}

/**
 * Long edit form on a phone (23): full-screen sheet, the same fields in the same order,
 * grouped under headings, sections beyond the first two collapsed to a summary row, and
 * a keyboard accessory bar that walks the fields in order.
 *
 * sections: [{ title, summary?, fields: [{ key, label, type?: 'text'|'number'|'date'|'datetime-local'|'select'|'textarea'|'email'|'tel', options?: [[value,label]], placeholder?, hint?, parse?(v) }] }]
 */
export function EditSheet({ title, sections, values, onChange, onCancel, onSave, saving, error, openSections = 2 }) {
  const all = sections.flatMap(s => s.fields);
  const [open, setOpen] = _useState(() => new Set(sections.slice(0, openSections).map(s => s.title)));
  const [focus, setFocus] = _useState(-1);
  const refs = _useRef({});
  const go = (i) => { const f = all[i]; if (!f) return; const sec = sections.find(s => s.fields.includes(f)); setOpen(o => new Set([...o, sec.title])); setTimeout(() => refs.current[f.key]?.focus(), 30); };
  const set = (f, raw) => onChange(f.key, f.parse ? f.parse(raw) : (raw === '' ? null : raw));
  const inputCls = 'w-full bg-transparent text-[15px] text-paper placeholder-dim focus:outline-none';
  return _createPortal(
    <div className="lg:hidden fixed inset-x-0 top-0 z-[70] flex flex-col" style={{ background: 'var(--scene-bg)', height: 'var(--app-vh, 100%)' }}>
      <div className="px-[18px] pt-3 pb-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--hair)', background: 'var(--panel-bg)' }}>
        <button type="button" onClick={onCancel} className="text-[14px] text-muted">Cancel</button>
        <div className="flex-1 min-w-0 text-center">
          <div className="text-[15px] font-bold text-paper truncate">{title}</div>
          <div className="text-[11px] text-dim">{all.length} fields · {sections.length} sections</div>
        </div>
        <button type="button" onClick={onSave} disabled={saving} className="text-[14px] font-semibold disabled:opacity-50" style={{ color: 'rgb(var(--c-primary-deep))' }}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      <div className="p-[14px] flex flex-col gap-3 pb-[90px] [&>*]:shrink-0" style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {error && <div className="px-[14px] py-2.5 rounded-[12px] text-[13px]" style={{ background: 'rgb(var(--c-coral) / .12)', color: 'rgb(var(--c-coral-deep))' }}>Could not save: {error}</div>}
        {sections.map(s => (
          <Card key={s.title}>
            {open.has(s.title) ? (
              <>
                <div className="px-[15px] py-2.5 border-b font-mono text-[9px] font-bold tracking-[.18em] uppercase text-dim" style={{ borderColor: 'var(--hair)' }}>{s.title}</div>
                {s.fields.map((f, i) => {
                  const idx = all.indexOf(f); const v = values[f.key] ?? '';
                  const common = { ref: (el) => { refs.current[f.key] = el; }, onFocus: () => setFocus(idx), className: inputCls, placeholder: f.placeholder || 'Add' };
                  return (
                    <div key={f.key} className={`px-[15px] py-[11px] ${i < s.fields.length - 1 ? 'border-b' : ''}`} style={{ borderColor: 'var(--hair)', background: focus === idx ? 'rgb(var(--c-primary) / .06)' : undefined }}>
                      <div className="text-[11px] text-dim mb-0.5">{f.label}</div>
                      {f.type === 'select' ? (
                        <select {...common} value={v ?? ''} onChange={e => set(f, e.target.value)}>{(f.options || []).map(([ov, ol]) => <option key={ov} value={ov}>{ol}</option>)}</select>
                      ) : f.type === 'textarea' ? (
                        <textarea {...common} rows={3} value={v ?? ''} onChange={e => set(f, e.target.value)} className={inputCls + ' resize-none'} />
                      ) : (
                        <input {...common} type={f.type || 'text'} value={f.type === 'datetime-local' ? String(v || '').slice(0, 16) : v ?? ''} onChange={e => set(f, e.target.value)} />
                      )}
                      {f.hint && <div className="text-[10px] text-dim mt-1">{f.hint}</div>}
                    </div>
                  );
                })}
              </>
            ) : (
              <button type="button" onClick={() => setOpen(o => new Set([...o, s.title]))} className="w-full px-[15px] py-3 flex items-center text-left">
                <span className="text-[15px] font-medium text-paper">{s.title}</span>
                <span className="ml-auto text-[12px] text-dim">{s.fields.length} fields{s.summary ? ` · ${s.summary}` : ''}</span>
              </button>
            )}
          </Card>
        ))}
      </div>
      {focus >= 0 && (
        <div className="absolute inset-x-0 bottom-0 px-[14px] py-2 border-t flex items-center gap-3" style={{ background: 'var(--panel-bg)', borderColor: 'var(--hair)', paddingBottom: 'calc(8px + env(safe-area-inset-bottom))' }}>
          <Mono>Field {focus + 1} of {all.length}</Mono>
          <span className="flex-1" />
          <button type="button" onClick={() => go(focus - 1)} disabled={focus <= 0} className="text-[13px] font-semibold text-paper disabled:opacity-40">Previous</button>
          <button type="button" onClick={() => go(focus + 1)} disabled={focus >= all.length - 1} className="text-[13px] font-semibold disabled:opacity-40" style={{ color: 'rgb(var(--c-primary-deep))' }}>Next</button>
        </div>
      )}
    </div>,
    document.body
  );
}
