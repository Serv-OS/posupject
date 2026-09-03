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
    <div onClick={onClick} className={`rounded-[16px] border overflow-hidden ${onClick ? 'cursor-pointer' : ''} ${className}`}
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
    <div className="flex items-center gap-3 px-[18px] py-[11px] rounded-[14px]"
      style={{ background: 'rgb(var(--c-text))', color: 'var(--on-accent)', boxShadow: 'var(--shadow-pop)' }}>
      <span className="text-[13px] font-semibold">{count} selected</span>
      <span className="w-px h-[18px]" style={{ background: 'var(--on-inverse-line)' }} />
      {actions.map(([label, fn, danger]) => (
        <button key={label} type="button" onClick={fn} className="text-[13px] hover:opacity-100 transition"
          style={{ color: danger ? 'rgb(var(--c-coral) / .85)' : 'var(--on-inverse-soft)' }}>{label}</button>
      ))}
      <button type="button" onClick={onClear} className="ml-auto text-[13px]" style={{ color: 'var(--on-inverse-soft)' }}>&times;</button>
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
        style={{ bottom: 'calc(56px + env(safe-area-inset-bottom))', background: 'linear-gradient(180deg, transparent, var(--scene) 30%)' }}>
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
