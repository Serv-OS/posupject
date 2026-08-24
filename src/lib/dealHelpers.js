import { supabase } from './supabase';

/**
 * When a deal moves to closed_won, auto-create an onboarding record
 * linked to the same company, copy associated locations, and write stage history.
 * Returns the new onboarding record if created, null otherwise.
 */
export async function handleClosedWon(dealId, profileId) {
  // Fetch the deal
  const { data: deal } = await supabase.from('deals').select('*').eq('id', dealId).single();
  if (!deal || deal.stage !== 'closed_won') return null;

  // Check if an onboarding already exists for this deal (prevent duplicates)
  const { data: existing } = await supabase.from('onboardings')
    .select('id').eq('deal_id', dealId).limit(1);
  if (existing?.length > 0) return existing[0];

  // The venue being onboarded. The deal already carries it as an affected
  // location; not copying it here is what leaves onboardings pinned to a
  // company instead of the site being installed.
  const { data: locLinks } = await supabase.from('associations')
    .select('from_type, from_id, to_type, to_id')
    .or(`and(from_type.eq.deal,from_id.eq.${dealId},to_type.eq.location),and(to_type.eq.deal,to_id.eq.${dealId},from_type.eq.location)`)
    .limit(1);
  const link = locLinks?.[0];
  let locationId = link ? (link.from_type === 'location' ? link.from_id : link.to_id) : null;
  if (!locationId && deal.company_id) {
    const { data: venues } = await supabase.from('locations').select('id').eq('company_id', deal.company_id).limit(2);
    if (venues?.length === 1) locationId = venues[0].id;
  }

  // Create the onboarding
  const { data: onboarding } = await supabase.from('onboardings').insert({
    company_id: deal.company_id,
    deal_id: dealId,
    location_id: locationId,
    owner_id: deal.owner_id,
    notes: `Auto-created from deal: ${deal.name}`,
  }).select().single();

  if (!onboarding) return null;

  // Write initial stage history for the onboarding
  await supabase.from('stage_history').insert({
    object_type: 'onboarding',
    object_id: onboarding.id,
    from_stage: null,
    to_stage: 'kickoff',
    changed_by: profileId,
  });

  // Copy location associations from the deal to the onboarding
  const { data: dealLocations } = await supabase.from('associations')
    .select('*')
    .eq('from_type', 'deal').eq('from_id', dealId).eq('to_type', 'location');

  if (dealLocations?.length > 0) {
    const locationAssocs = dealLocations.map(a => ({
      from_type: 'onboarding',
      from_id: onboarding.id,
      to_type: 'location',
      to_id: a.to_id,
      label: a.label || 'affected_location',
    }));
    await supabase.from('associations').insert(locationAssocs);
  }

  // Copy contact associations from the deal to the onboarding
  const { data: dealContacts } = await supabase.from('associations')
    .select('*')
    .eq('from_type', 'deal').eq('from_id', dealId).eq('to_type', 'contact');

  if (dealContacts?.length > 0) {
    const contactAssocs = dealContacts.map(a => ({
      from_type: 'onboarding',
      from_id: onboarding.id,
      to_type: 'contact',
      to_id: a.to_id,
      label: a.label,
    }));
    await supabase.from('associations').insert(contactAssocs);
  }

  return onboarding;
}
