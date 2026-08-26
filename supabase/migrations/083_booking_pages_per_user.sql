-- Booking pages belong to a person, not to the instance.
--
-- The old policy let any editor edit any page, which is wrong the moment two
-- people each have one: their availability, their calendar, their link. Owners
-- keep full reach (someone has to be able to tidy up after a leaver).
drop policy if exists booking_types_write on public.booking_types;
create policy booking_types_write on public.booking_types for all
  using (
    host_user_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  )
  with check (
    host_user_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  );

-- Bookings stay readable to the whole team (a colleague covering a call needs
-- to see it), but only the host or an owner can change one.
drop policy if exists bookings_write on public.bookings;
create policy bookings_write on public.bookings for all
  using (
    host_user_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  )
  with check (
    host_user_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  );
