-- The team needs to SEE the connected mailbox; nobody needs the TOKEN.
--
-- Locking the whole table to the owner was too blunt: an editor opening
-- Settings saw "no mailbox connected", which is wrong and alarming. But the
-- row carries a live Google refresh_token, and a refresh token in a browser is
-- a standing key to the company mailbox that keeps working after that person's
-- CRM login is revoked.
--
-- So: a view with the metadata and no secrets. Views run with the definer's
-- rights, so this reads the locked table on the caller's behalf while making
-- it impossible to select a column that is not listed here.
create or replace view public.gmail_connections_safe as
  select id, email, is_active, connected_by, created_at, updated_at,
         last_polled_at, token_expires_at,
         -- Enough to show "connected and healthy" without handing over the key.
         (refresh_token is not null) as has_refresh_token
    from public.gmail_connections;

grant select on public.gmail_connections_safe to authenticated;

-- The base table keeps its owner-only read. Edge functions use the service
-- role and are unaffected; no browser has any reason to read a token.
