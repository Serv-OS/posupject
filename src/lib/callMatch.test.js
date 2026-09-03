import { describe, it, expect } from 'vitest';
import { digits10, samePhone, callPartyNumber, contactForCall, callPartyLabel, contactsForNumber, isSharedLine, isPlaceholderContact } from './callMatch.js';

const GYROS = { id: 'c1', first_name: 'Gyros', last_name: 'Express', phone: '07432203290' };
const OTHER = { id: 'c2', first_name: 'Vicky', last_name: null, phone: '+44 7415 602105' };
const BOOK = [GYROS, OTHER];

describe('samePhone', () => {
  // The reported case: the same line written three ways.
  it('treats +44, 44 and 0 forms as one number', () => {
    for (const n of ['+447432203290', '447432203290', '07432203290', '07432 203290', '(07432) 203-290']) {
      expect(samePhone(n, GYROS.phone)).toBe(true);
    }
  });
  it('does not match a different number', () => {
    expect(samePhone('+447432203291', GYROS.phone)).toBe(false);
  });
  // A short extension must never match half the address book.
  it('refuses to match on too few digits', () => {
    expect(samePhone('2290', '07432202290')).toBe(false);
    expect(samePhone('', '07432203290')).toBe(false);
    expect(digits10('123')).toBe('123');
  });
});

describe('callNumber', () => {
  it('reads every key shape Twilio has written', () => {
    expect(callPartyNumber({ direction: 'outbound', channel_metadata: { to: '447432203290' } })).toBe('447432203290');
    expect(callPartyNumber({ direction: 'outbound', channel_metadata: { to_number: '447432203290' } })).toBe('447432203290');
    expect(callPartyNumber({ direction: 'inbound', channel_metadata: { from_number: '+447415602105' } })).toBe('+447415602105');
  });
  it('picks the other party, not us', () => {
    const a = { direction: 'inbound', channel_metadata: { from_number: '+447415602105', to_number: '+441134960000' } };
    expect(callPartyNumber(a)).toBe('+447415602105');
    const b = { direction: 'outbound', channel_metadata: { from_number: '+441134960000', to_number: '+447432203290' } };
    expect(callPartyNumber(b)).toBe('+447432203290');
  });
  it('returns null when there is no number at all', () => {
    expect(callPartyNumber({ channel_metadata: {} })).toBeNull();
    expect(callPartyNumber({})).toBeNull();
  });
});

describe('contactForCall', () => {
  it('uses the explicit link when there is one', () => {
    expect(contactForCall({ contact_id: 'c2', channel_metadata: {} }, BOOK)).toBe(OTHER);
  });
  // The 24-of-27 case: no contact_id, but the number is in the address book.
  it('falls back to the number when the call was never linked', () => {
    const call = { contact_id: null, direction: 'outbound', channel_metadata: { to: '447432203290' } };
    expect(contactForCall(call, BOOK)).toBe(GYROS);
  });
  it('still matches when the link points at a contact we did not load', () => {
    const call = { contact_id: 'deleted', direction: 'outbound', channel_metadata: { to: '447432203290' } };
    expect(contactForCall(call, BOOK)).toBe(GYROS);
  });
  it('returns null for a genuinely unknown number', () => {
    expect(contactForCall({ channel_metadata: { to: '+441619990000' } }, BOOK)).toBeNull();
  });
});

describe('callPartyLabel', () => {
  it('shows the name once it can find one', () => {
    expect(callPartyLabel({ direction: 'outbound', channel_metadata: { to: '+447432203290' } }, BOOK)).toBe('Gyros Express');
  });
  it('falls back to the number, never to nothing', () => {
    expect(callPartyLabel({ channel_metadata: { to: '+441619990000' } }, BOOK)).toBe('+441619990000');
    expect(callPartyLabel({ channel_metadata: {} }, BOOK)).toBe('Unknown number');
  });
  // An empty contacts list is exactly what the broken query produced.
  it('degrades to the number if contacts failed to load', () => {
    expect(callPartyLabel({ direction: 'outbound', channel_metadata: { to: '+447432203290' } }, [])).toBe('+447432203290');
  });
});

describe('shared lines', () => {
  // Real data: one shop phone answered by two named people.
  const SHOP_A = { id: 's1', first_name: 'Vicky', last_name: 'CB - Castleford', phone: '+447415602105' };
  const SHOP_B = { id: 's2', first_name: 'Staff', last_name: 'CB - Castleford', phone: '07415602105' };
  const BOOK2 = [SHOP_A, SHOP_B];
  const call = { contact_id: null, direction: 'inbound', channel_metadata: { from_number: '+447415602105' } };

  it('finds both holders of the number', () => {
    expect(contactsForNumber('+447415602105', BOOK2)).toHaveLength(2);
  });

  // The point: a name printed as fact must not be a coin toss.
  it('refuses to guess which of them it was', () => {
    expect(contactForCall(call, BOOK2)).toBeNull();
    expect(callPartyLabel(call, BOOK2)).toBe('+447415602105');
    expect(isSharedLine(call, BOOK2)).toBe(true);
  });

  it('but an explicit link still wins, because a person made that call', () => {
    expect(contactForCall({ ...call, contact_id: 's2' }, BOOK2)).toBe(SHOP_B);
    expect(isSharedLine({ ...call, contact_id: 's2' }, BOOK2)).toBe(false);
  });

  it('a number held by exactly one contact is not a shared line', () => {
    expect(isSharedLine({ channel_metadata: { to: '07432203290' } }, [
      { id: 'x', first_name: 'Gyros', last_name: 'Express', phone: '07432203290' },
    ])).toBe(false);
  });
});

describe('placeholder contacts', () => {
  // Straight from the live book: two auto-created rows named after the number,
  // plus the person you actually know.
  const PH1 = { id: 'p1', first_name: '+447432468971', last_name: null, phone: '+447432468971' };
  const PH2 = { id: 'p2', first_name: '+447432468971', last_name: null, phone: '+447432468971' };
  const REAL = { id: 'r1', first_name: 'Staff', last_name: 'CB - Castleford', phone: '+447432468971' };
  const call = { contact_id: null, direction: 'inbound', channel_metadata: { from_number: '+447432468971' } };

  it('recognises a contact named after its own number', () => {
    expect(isPlaceholderContact(PH1)).toBe(true);
    expect(isPlaceholderContact(REAL)).toBe(false);
    expect(isPlaceholderContact({ first_name: null, last_name: null })).toBe(true);
  });

  it('junk rows do not hide the person you know', () => {
    expect(contactForCall(call, [PH1, PH2, REAL])).toBe(REAL);
    expect(callPartyLabel(call, [PH1, PH2, REAL])).toBe('Staff CB - Castleford');
    expect(isSharedLine(call, [PH1, PH2, REAL])).toBe(false);
  });

  it('all placeholders and no real name still shows the number', () => {
    expect(contactForCall(call, [PH1, PH2])).toBeNull();
    expect(callPartyLabel(call, [PH1, PH2])).toBe('+447432468971');
  });

  it('the same person entered twice is not ambiguous', () => {
    const a = { id: 'v1', first_name: 'Vicky', last_name: 'CB - Castleford', phone: '+447415602105' };
    const b = { id: 'v2', first_name: 'Vicky', last_name: 'CB - Castleford', phone: '07415602105' };
    const c = { contact_id: null, direction: 'inbound', channel_metadata: { from_number: '+447415602105' } };
    expect(callPartyLabel(c, [a, b])).toBe('Vicky CB - Castleford');
    expect(isSharedLine(c, [a, b])).toBe(false);
  });

  it('two genuinely different people on one line stay unresolved', () => {
    const a = { id: 'g1', first_name: 'Richard', last_name: 'Gunn (Coffee Boy)', phone: '+447730979999' };
    const b = { id: 'g2', first_name: 'Richard', last_name: 'Gunn (Doboy)', phone: '+447730979999' };
    const c = { contact_id: null, direction: 'inbound', channel_metadata: { from_number: '+447730979999' } };
    expect(contactForCall(c, [a, b])).toBeNull();
    expect(isSharedLine(c, [a, b])).toBe(true);
  });
});
