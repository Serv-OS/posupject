// Shared building blocks for the card-style list views (matches ProjectList).
export function ListContainer({ children }) {
  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="max-w-4xl space-y-3">{children}</div>
    </div>
  );
}

export function RecordCard({ onClick, href, children, highlight = false }) {
  const cls = `glass-card rounded-2xl p-5 cursor-pointer hover:border-ember/30 transition ${highlight ? 'ring-2 ring-amber-400/60' : ''}`;
  if (!href) return <div onClick={onClick} className={cls}>{children}</div>;

  // With an href this is a REAL anchor, so right-click "Open in new tab",
  // Cmd-click, middle-click and "Copy link" all behave the way they do on every
  // other website. A div with an onClick cannot do any of that: the browser has
  // no idea it leads anywhere, so the context menu has nothing to offer.
  //
  // A plain left click is still handled in-app, so navigation stays instant and
  // does not reload the whole CRM. Anything with a modifier, or a middle click,
  // is left alone for the browser to deal with.
  const handle = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onClick?.(e);
  };
  return <a href={href} onClick={handle} className={`block ${cls}`}>{children}</a>;
}

export function CardHead({ title, subtitle, badge }) {
  return (
    <div className="flex items-start gap-3 mb-2">
      <div className="flex-1 min-w-0">
        <div className="text-base font-semibold text-paper">{title}</div>
        {subtitle && <div className="text-xs text-muted mt-0.5 line-clamp-2">{subtitle}</div>}
      </div>
      {badge && <span className="shrink-0">{badge}</span>}
    </div>
  );
}

export function Chip({ tone = 'slate', icon, children }) {
  if (children == null || children === '') return null;
  const cls = tone === 'ember'
    ? 'bg-ember/10 text-ember-deep border border-ember/20'
    : 'bg-slate-100 text-slate-600 border border-slate-200';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg ${cls}`}>
      {icon && <span>{icon}</span>}{children}
    </span>
  );
}

export function ChipRow({ children }) {
  const has = Array.isArray(children) ? children.some(Boolean) : !!children;
  if (!has) return null;
  return <div className="flex items-center gap-2 mb-3 flex-wrap">{children}</div>;
}

export function MetaRow({ children }) {
  return <div className="flex items-center gap-4 flex-wrap text-xs text-muted">{children}</div>;
}

export function OwnerTag({ name }) {
  if (!name) return null;
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-5 h-5 rounded-full bg-ember text-white text-[9px] font-bold flex items-center justify-center">
        {name[0]?.toUpperCase() || '?'}
      </span>
      {name}
    </span>
  );
}
