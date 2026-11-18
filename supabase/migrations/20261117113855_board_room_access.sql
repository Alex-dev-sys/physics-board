-- Private room capabilities and membership-based access for Physics Board.
create schema if not exists board_private;
revoke all on schema board_private from public, anon, authenticated;

create table public.board_rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.board_members (
  room_id uuid not null references public.board_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index board_members_user_room_idx on public.board_members(user_id, room_id);
create table public.board_documents (
  room_id uuid primary key references public.board_rooms(id) on delete cascade,
  snapshot jsonb not null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint board_snapshot_size check (octet_length(snapshot::text) <= 12582912)
);
create table board_private.room_secrets (
  room_id uuid primary key references public.board_rooms(id) on delete cascade,
  token_hash bytea not null unique
);
revoke all on all tables in schema board_private from public, anon, authenticated;

alter table public.board_rooms enable row level security;
alter table public.board_members enable row level security;
alter table public.board_documents enable row level security;
revoke all on public.board_rooms, public.board_members, public.board_documents from public, anon, authenticated;
grant select on public.board_rooms, public.board_members, public.board_documents to authenticated;
create policy "members see own membership" on public.board_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy "members read rooms" on public.board_rooms for select to authenticated
  using (exists (select 1 from public.board_members m where m.room_id = board_rooms.id and m.user_id = (select auth.uid())));
create policy "members read documents" on public.board_documents for select to authenticated
  using (exists (select 1 from public.board_members m where m.room_id = board_documents.room_id and m.user_id = (select auth.uid())));

-- Only these carefully scoped functions can create rooms or add membership.
create function public.create_board_room(p_token text, p_snapshot jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_room uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'invalid invitation'; end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' or not (p_snapshot ? 'store' and p_snapshot ? 'schema') or octet_length(p_snapshot::text) > 12582912 then
    raise exception 'invalid snapshot';
  end if;
  insert into public.board_rooms(owner_id) values (v_uid) returning id into v_room;
  insert into public.board_members(room_id, user_id) values (v_room, v_uid);
  insert into board_private.room_secrets(room_id, token_hash) values (v_room, extensions.digest(p_token, 'sha256'));
  insert into public.board_documents(room_id, snapshot) values (v_room, p_snapshot);
  return v_room;
end $$;
create function public.join_board_room(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_room uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'invalid invitation'; end if;
  select room_id into v_room from board_private.room_secrets where token_hash = extensions.digest(p_token, 'sha256');
  if v_room is null then raise exception 'room not found' using errcode = 'P0002'; end if;
  insert into public.board_members(room_id, user_id) values (v_room, v_uid) on conflict do nothing;
  return v_room;
end $$;
create function public.save_board_snapshot(p_room uuid, p_revision bigint, p_snapshot jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_revision bigint; v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (select 1 from public.board_members where room_id=p_room and user_id=v_uid) then
    raise exception 'not a room member' using errcode = '42501';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' or not (p_snapshot ? 'store' and p_snapshot ? 'schema') or octet_length(p_snapshot::text) > 12582912 then
    raise exception 'invalid snapshot';
  end if;
  update public.board_documents set snapshot=p_snapshot, revision=revision+1, updated_at=now()
   where room_id=p_room and revision=p_revision returning revision into v_revision;
  if v_revision is null then raise exception 'snapshot version conflict' using errcode='40001'; end if;
  return v_revision;
end $$;
revoke all on function public.create_board_room(text,jsonb), public.join_board_room(text), public.save_board_snapshot(uuid,bigint,jsonb) from public, anon;
grant execute on function public.create_board_room(text,jsonb), public.join_board_room(text), public.save_board_snapshot(uuid,bigint,jsonb) to authenticated;

-- Private channels only: the client must join with config.private=true.
create policy "board members receive realtime" on realtime.messages for select to authenticated
 using (extension in ('broadcast','presence') and exists (
   select 1 from public.board_members m where m.user_id=(select auth.uid()) and 'board:' || m.room_id::text = (select realtime.topic())
 ));
create policy "board members send realtime" on realtime.messages for insert to authenticated
 with check (extension in ('broadcast','presence') and exists (
   select 1 from public.board_members m where m.user_id=(select auth.uid()) and 'board:' || m.room_id::text = (select realtime.topic())
 ));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values ('board-materials','board-materials',false,52428800,array['image/png','image/jpeg','image/webp','image/gif','application/pdf']);
create policy "board members read materials" on storage.objects for select to authenticated
 using (bucket_id='board-materials' and exists (
   select 1 from public.board_members m where m.user_id=(select auth.uid()) and m.room_id::text=(storage.foldername(name))[1]
 ));
create policy "board members upload materials" on storage.objects for insert to authenticated
 with check (bucket_id='board-materials' and exists (
   select 1 from public.board_members m where m.user_id=(select auth.uid()) and m.room_id::text=(storage.foldername(name))[1]
 ));

