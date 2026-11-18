-- Clients can read validated state and stage their own large uploads. Only the
-- application server can publish a checkpoint after validating the Yjs state.
create table public.board_checkpoints (
  room_id uuid primary key references public.board_rooms(id) on delete cascade,
  revision bigint not null check (revision > 0),
  payload text not null check (octet_length(payload) between 4 and 33554432)
);

alter table public.board_checkpoints enable row level security;
revoke all on public.board_checkpoints from public, anon, authenticated;
grant select on public.board_checkpoints to authenticated;
grant select, insert, update on public.board_checkpoints to service_role;
grant select on public.board_rooms, public.board_members, public.board_documents, public.board_updates to service_role;
create policy "members read board checkpoints" on public.board_checkpoints
  for select to authenticated using (exists (
    select 1 from public.board_members m
    where m.room_id = board_checkpoints.room_id and m.user_id = (select auth.uid())
  ));

create table public.board_update_parts (
  room_id uuid not null references public.board_rooms(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  upload_id uuid not null,
  part smallint not null check (part between 0 and 63),
  payload text not null check (octet_length(payload) between 4 and 524288),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id, upload_id, part)
);

create index board_update_parts_created_at_idx on public.board_update_parts (created_at);
alter table public.board_update_parts enable row level security;
revoke all on public.board_update_parts from public, anon, authenticated;
grant select, delete on public.board_update_parts to authenticated;
grant insert (room_id, upload_id, part, payload) on public.board_update_parts to authenticated;
grant select, delete on public.board_update_parts to service_role;
create policy "members stage their own board updates" on public.board_update_parts
  for all to authenticated
  using (user_id = (select auth.uid()) and exists (
    select 1 from public.board_members m
    where m.room_id = board_update_parts.room_id and m.user_id = (select auth.uid())
  ))
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.board_members m
    where m.room_id = board_update_parts.room_id and m.user_id = (select auth.uid())
  ));

-- Freeze the legacy log for read-only recovery. Direct unvalidated appends
-- must stay disabled even for an authenticated room member.
revoke execute on function public.append_board_update(uuid,uuid,text) from public, anon, authenticated;
revoke execute on function board_private.append_board_update(uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.save_board_snapshot(uuid,bigint,jsonb) from public, anon, authenticated;
revoke execute on function board_private.save_board_snapshot(uuid,bigint,jsonb) from public, anon, authenticated;
