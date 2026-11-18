-- 127_kb_search.sql (safe to run twice)
--
-- Peter, 18 Nov 2026: ticket 1035, the support chat could not say whether
-- staff have an app. Two holes: kb_docs was empty, and the kb_search function
-- the chat calls was never created (migration 082 made the table and its index
-- only), so the chat has never been able to look anything up, and nothing ever
-- filled kb_docs.search.
--
-- 1. kb_docs.search is kept up to date from the title, question and answer.
-- 2. kb_search(q, loc, mods, lim, trusted): the best matching answers for what
--    the visitor wrote. Any word may match (not every word), best first.

-- 1. The search index, filled on every write.
create or replace function public.kb_docs_index()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search :=
       setweight(to_tsvector('english', coalesce(new.title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(new.question, '')), 'B')
    || setweight(to_tsvector('english', coalesce(new.answer, '')), 'C')
    || setweight(to_tsvector('english', coalesce(new.category, '') || ' ' || coalesce(new.module, '')), 'D');
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_kb_docs_index on public.kb_docs;
create trigger trg_kb_docs_index
  before insert or update of title, question, answer, category, module on public.kb_docs
  for each row execute function public.kb_docs_index();

-- Index what is already there.
update public.kb_docs set title = title;

-- 2. The lookup the chat calls.
create or replace function public.kb_search(q text, loc uuid default null, mods text[] default null,
                                            lim integer default 5, trusted boolean default false)
returns table (id uuid, title text, question text, answer text, category text, rank real)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_and text := plainto_tsquery('english', coalesce(q, ''))::text;
  v_q tsquery;
begin
  -- Only stop words ("is it a"): nothing to look for.
  if v_and is null or v_and = '' then return; end if;
  v_q := replace(v_and, ' & ', ' | ')::tsquery;
  return query
    select d.id, d.title, d.question, d.answer, d.category, ts_rank(d.search, v_q) as rank
      from kb_docs d
     where d.active
       and d.search @@ v_q
       and (trusted or not d.internal_only)
       and (d.location_id is null or d.location_id = loc)
       and (d.module is null or mods is null or d.module = any(mods))
     order by ts_rank(d.search, v_q) desc, d.first_line desc, d.uses desc
     limit greatest(1, least(coalesce(lim, 5), 10));
end;
$$;
revoke all on function public.kb_search(text, uuid, text[], integer, boolean) from public, anon, authenticated;
grant execute on function public.kb_search(text, uuid, text[], integer, boolean) to service_role;

-- ROLLBACK
--   drop function public.kb_search(text, uuid, text[], integer, boolean);
--   drop trigger trg_kb_docs_index on public.kb_docs;
--   drop function public.kb_docs_index();
