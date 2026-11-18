-- A version conflict is an application response, not a serialization failure.
-- Raising 40001 makes some database middleware retry until request timeout.
create or replace function board_private.save_board_snapshot(p_room uuid, p_revision bigint, p_snapshot jsonb) returns bigint
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
  if v_revision is null then raise sqlstate 'PT409' using message='snapshot version conflict'; end if;
  return v_revision;
end $$;
