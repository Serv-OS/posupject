-- The public support chatbot: the embeddable widget, its knowledge, and the
-- conversations it has.
--
-- Reproduced from the working posupcrm schema rather than rewritten, so the
-- shared `chat` function behaves identically here. Note there is deliberately
-- NO anon policy on any of these: the widget never touches the database
-- directly, it goes through the chat function, which runs as service_role and
-- checks the site key and the caller's Origin itself.

create table if not exists public.chat_sites (
  id              uuid primary key default gen_random_uuid(),
  site_key        text not null unique,
  label           text not null,
  allowed_origins text[] not null default '{}'::text[],
  location_id     uuid references public.locations(id) on delete set null,
  mode            text not null default 'popup' check (mode in ('popup','inline')),
  active          boolean not null default true,
  trust           text not null default 'public' check (trust in ('public','internal')),
  created_at      timestamptz not null default now()
);

create table if not exists public.chat_sessions (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid references public.chat_sites(id) on delete set null,
  location_id    uuid references public.locations(id) on delete set null,
  contact_id     uuid references public.contacts(id) on delete set null,
  visitor_name   text,
  visitor_email  text,
  visitor_phone  text,
  status         text not null default 'open' check (status in ('open','escalated','closed')),
  ticket_id      uuid references public.tickets(id) on delete set null,
  origin         text,
  pending_reason text,
  started_at     timestamptz not null default now(),
  last_at        timestamptz not null default now()
);
create index if not exists chat_sessions_started_idx on public.chat_sessions (started_at desc);

create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role       text not null check (role in ('visitor','bot','agent')),
  content    text not null,
  confidence numeric,
  escalated  boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_session_idx on public.chat_messages (session_id, created_at);

-- What the bot may say, and what it must never attempt.
create table if not exists public.chat_playbook (
  id               integer primary key default 1,
  enabled          boolean not null default true,
  greeting         text not null default 'Hi! I''m here to help with anything ServOS. What can I do for you?',
  tone             text not null default 'friendly, concise, natural British English',
  ask_location     boolean not null default true,
  never_answer     text[] not null default array['pricing','contracts','cancellation','refunds','legal'],
  always_escalate  text[] not null default array['system down','payments failing','data loss'],
  persona_names    text[] not null default '{}'::text[],
  unknown_reply    text not null default 'I don''t know the answer to that one — I''ll raise it with the next level of support and someone will come back to you.',
  business_context text,
  updated_at       timestamptz not null default now()
);
insert into public.chat_playbook (id) values (1) on conflict (id) do nothing;

-- The answers it draws on. `search` is a plain tsvector maintained by the
-- ingest functions, not a generated column, so a doc can be indexed on wording
-- the author never typed.
create table if not exists public.kb_docs (
  id            uuid primary key default gen_random_uuid(),
  source        text not null default 'manual',
  source_ref    text,
  title         text,
  question      text not null,
  answer        text not null,
  category      text,
  module        text,
  location_id   uuid references public.locations(id) on delete set null,
  active        boolean not null default true,
  internal_only boolean not null default false,
  first_line    boolean not null default false,
  uses          integer not null default 0,
  created_by    uuid,
  search        tsvector,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists kb_docs_search_idx on public.kb_docs using gin (search);
create index if not exists kb_docs_active_idx on public.kb_docs (active);

alter table public.chat_sites    enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_playbook enable row level security;
alter table public.kb_docs       enable row level security;

do $$
declare t text;
begin
  foreach t in array array['chat_sites','chat_sessions','chat_messages','chat_playbook','kb_docs'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (auth.uid() is not null)', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($f$create policy %I on public.%I for all
      using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['owner','editor'])))
      with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['owner','editor'])))$f$,
      t || '_write', t);
  end loop;
end $$;
