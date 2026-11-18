-- Only a room owner can remove material; members may read and add files.
create policy "board owners delete materials" on storage.objects for delete to authenticated
 using (bucket_id='board-materials' and exists (
   select 1 from public.board_rooms r where r.owner_id=(select auth.uid()) and r.id::text=(storage.foldername(name))[1]
 ));
