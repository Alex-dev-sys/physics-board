-- Ordered, idempotent Yjs updates. A per-room row lock makes sequence numbers
-- reflect commit order, so reconnecting clients cannot skip a concurrent write.
create table public.board_updates (
  room_id uuid not null references public.board_rooms(id) on delete cascade,
  sequence bigint not null,
  update_id uuid not null,
  payload text not null,
  created_at timestamptz not null default now(),
  primary key (room_id, sequence),
  unique (room_id, update_id),
  constraint board_update_size check (octet_length(payload) between 4 and 8388608)
);
create table board_private.room_clocks (
  room_id uuid primary key references public.board_rooms(id) on delete cascade,
  sequence bigint not null default 0
);
revoke all on board_private.room_clocks from public, anon, authenticated;
alter table public.board_updates enable row level security;
revoke all on public.board_updates from public, anon, authenticated;
grant select on public.board_updates to authenticated;
create policy "members read board updates" on public.board_updates for select to authenticated
 using (exists (select 1 from public.board_members m where m.room_id=board_updates.room_id and m.user_id=(select auth.uid())));

create function board_private.append_board_update(p_room uuid, p_update_id uuid, p_payload text) returns bigint
language plpgsql security definer set search_path='' as $$
declare v_user uuid := auth.uid(); v_sequence bigint; v_existing text;
begin
  if v_user is null or not exists (select 1 from public.board_members m where m.room_id=p_room and m.user_id=v_user) then
    raise exception 'not a room member' using errcode='42501';
  end if;
  if p_update_id is null or p_payload is null or octet_length(p_payload) not between 4 and 8388608 or p_payload !~ '^[A-Za-z0-9+/]*={0,2}$' then
    raise exception 'invalid update';
  end if;
  insert into board_private.room_clocks(room_id) values (p_room) on conflict do nothing;
  perform 1 from board_private.room_clocks where room_id=p_room for update;
  select sequence,payload into v_sequence,v_existing from public.board_updates where room_id=p_room and update_id=p_update_id;
  if found then
    if v_existing <> p_payload then raise exception 'update id reused'; end if;
    return v_sequence;
  end if;
  update board_private.room_clocks set sequence=sequence+1 where room_id=p_room returning sequence into v_sequence;
  insert into public.board_updates(room_id,sequence,update_id,payload) values (p_room,v_sequence,p_update_id,p_payload);
  return v_sequence;
end $$;
revoke all on function board_private.append_board_update(uuid,uuid,text) from public, anon;
grant execute on function board_private.append_board_update(uuid,uuid,text) to authenticated;
create function public.append_board_update(p_room uuid, p_update_id uuid, p_payload text) returns bigint
language sql security invoker set search_path='' as $$ select board_private.append_board_update(p_room,p_update_id,p_payload) $$;
revoke all on function public.append_board_update(uuid,uuid,text) from public, anon;
grant execute on function public.append_board_update(uuid,uuid,text) to authenticated;
