-- An uploader may cancel its own unfinished upload while remaining a room member.
create policy "board uploaders delete own materials" on storage.objects for delete to authenticated
 using (bucket_id='board-materials' and owner_id=(select auth.uid())::text and exists (
   select 1 from public.board_members m where m.user_id=(select auth.uid()) and m.room_id::text=(storage.foldername(name))[1]
 ));
