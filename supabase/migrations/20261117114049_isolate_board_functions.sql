-- Keep privileged implementation functions outside the exposed API schema.
alter function public.create_board_room(text,jsonb) set schema board_private;
alter function public.join_board_room(text) set schema board_private;
alter function public.save_board_snapshot(uuid,bigint,jsonb) set schema board_private;
grant usage on schema board_private to authenticated;
grant execute on function board_private.create_board_room(text,jsonb), board_private.join_board_room(text), board_private.save_board_snapshot(uuid,bigint,jsonb) to authenticated;

create function public.create_board_room(p_token text,p_snapshot jsonb) returns uuid
language sql security invoker set search_path='' as $$ select board_private.create_board_room(p_token,p_snapshot) $$;
create function public.join_board_room(p_token text) returns uuid
language sql security invoker set search_path='' as $$ select board_private.join_board_room(p_token) $$;
create function public.save_board_snapshot(p_room uuid,p_revision bigint,p_snapshot jsonb) returns bigint
language sql security invoker set search_path='' as $$ select board_private.save_board_snapshot(p_room,p_revision,p_snapshot) $$;
revoke all on function public.create_board_room(text,jsonb), public.join_board_room(text), public.save_board_snapshot(uuid,bigint,jsonb) from public, anon;
grant execute on function public.create_board_room(text,jsonb), public.join_board_room(text), public.save_board_snapshot(uuid,bigint,jsonb) to authenticated;
