import { describe, it, expect } from 'vitest';
import { sameValue, sameActivities, arrivedAtBottom, followNewRows, mentionIds, addedMentions, latestEmail, needsRecipientLookup, emailHeadersOf, replyDefaults, recipientsToSend, formatAddresses, isSendShortcut, newestAt } from './conversation.js';

const SUPPORT = 'support@serv-os.app';
const row = (id, extra = {}) => ({ id, occurred_at: `2026-09-11T10:0${id.length}:00Z`, type: 'note', body: 'x', is_internal: true, channel_metadata: {}, ...extra });

describe('refresh with no change keeps the list on screen', () => {
  it('a fresh copy of the same rows is the same', () => {
    const prev = [row('a', { channel_metadata: { to: 'dan@x.com', nested: { n: [1, 2] } } }), row('b')];
    const next = JSON.parse(JSON.stringify(prev));
    expect(sameActivities(prev, next)).toBe(true);
  });
  it('an edited note, a stamped edit or recipients saved later all count as a change', () => {
    const prev = [row('a'), row('b', { channel_metadata: { from: 'dan@x.com' } })];
    expect(sameActivities(prev, [row('a', { body: 'y' }), prev[1]])).toBe(false);
    expect(sameActivities(prev, [row('a', { edited_at: '2026-09-11T11:00:00Z' }), prev[1]])).toBe(false);
    expect(sameActivities(prev, [prev[0], row('b', { channel_metadata: { from: 'dan@x.com', to: SUPPORT } })])).toBe(false);
    expect(sameActivities(prev, [prev[0]])).toBe(false);
  });
  it('compares jsonb deeply', () => {
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
  });
});

describe('when new rows may move the view', () => {
  const ids = new Set(['a', 'b']);
  it('only rows that land at the bottom count as new', () => {
    expect(arrivedAtBottom(ids, [row('a'), row('b')])).toEqual([]);
    expect(arrivedAtBottom(ids, [row('a'), row('b'), row('c')]).map((r) => r.id)).toEqual(['c']);
    // back-dated insert above the latest row, or the latest row deleted: nothing new at the bottom
    expect(arrivedAtBottom(ids, [row('z'), row('a'), row('b')])).toEqual([]);
    expect(arrivedAtBottom(ids, [row('a')])).toEqual([]);
  });
  it('a reader scrolled up keeps their place, and sees a count instead', () => {
    expect(followNewRows({ fresh: [row('c', { actor_id: 'them' })], nearBottom: false, myId: 'me' })).toBe('count');
    expect(followNewRows({ fresh: [row('c', { actor_id: 'them' })], nearBottom: true, myId: 'me' })).toBe('follow');
    expect(followNewRows({ fresh: [], nearBottom: true, myId: 'me' })).toBe('stay');
  });
  it('our own message always shows, and a note being edited is never scrolled away from', () => {
    expect(followNewRows({ fresh: [row('c', { actor_id: 'me' })], nearBottom: false, myId: 'me' })).toBe('follow');
    expect(followNewRows({ fresh: [row('c', { actor_id: 'them' })], nearBottom: true, myId: 'me', editing: true })).toBe('count');
  });
});

describe('mentions on an edited note', () => {
  it('only the newly mentioned people are notified', () => {
    const before = 'Hi @[Sarah](u-sarah) and @[Sarah](u-sarah)';
    expect(mentionIds(before)).toEqual(['u-sarah']);
    expect(addedMentions(before, 'Hi @[Sarah](u-sarah), @[James](u-james)')).toEqual(['u-james']);
    expect(addedMentions(before, 'Hi all')).toEqual([]);
  });
});

describe('ticket reply recipients', () => {
  const inbound = { id: 'e9', type: 'email', direction: 'inbound', channel_metadata: { from: 'Dan <dan@venue.com>', to: `${SUPPORT}, ops@venue.com`, cc: 'kate@venue.com' } };
  it('answers the latest email, whichever way it went', () => {
    expect(latestEmail([inbound, row('n1'), { id: 'e10', type: 'email' }, row('n2')]).id).toBe('e10');
    expect(latestEmail([row('n1')])).toBe(null);
  });
  it('looks recipients up once for an older email that has no To stored', () => {
    expect(needsRecipientLookup({ type: 'email', channel_metadata: { from: 'dan@venue.com', gmail_message_id: 'g1' } })).toBe(true);
    expect(needsRecipientLookup({ type: 'email', channel_metadata: { from: 'dan@venue.com', gmail_message_id: 'g1', to: null } })).toBe(false);
    expect(needsRecipientLookup({ type: 'email', channel_metadata: { from: 'dan@venue.com' } })).toBe(false);
    expect(needsRecipientLookup({ type: 'note', channel_metadata: { gmail_message_id: 'g1' } })).toBe(false);
  });
  it('Reply all copies everyone else, Reply only the sender', () => {
    const h = emailHeadersOf(inbound, null, SUPPORT);
    expect(replyDefaults(h, [SUPPORT], '', 'reply')).toEqual({ to: [{ name: 'Dan', email: 'dan@venue.com' }], cc: [] });
    expect(replyDefaults(h, [SUPPORT], '', 'all').cc.map((a) => a.email)).toEqual(['ops@venue.com', 'kate@venue.com']);
  });
  it('uses the headers read back from Gmail for an older email', () => {
    const old = { id: 'e1', type: 'email', direction: 'inbound', channel_metadata: { from: 'dan@venue.com', gmail_message_id: 'g1' } };
    const h = emailHeadersOf(old, { from: null, to: `${SUPPORT}, ops@venue.com`, cc: null, reply_to: null }, SUPPORT);
    expect(h).toEqual({ from: 'dan@venue.com', to: `${SUPPORT}, ops@venue.com`, cc: '', reply_to: '' });
    expect(replyDefaults(h, [SUPPORT], '', 'all').cc.map((a) => a.email)).toEqual(['ops@venue.com']);
  });
  it('after our own reply, the next one still goes to the same people', () => {
    const sent = { type: 'email', direction: 'outbound', channel_metadata: { from: SUPPORT, to: 'dan@venue.com', cc: 'kate@venue.com' } };
    expect(replyDefaults(emailHeadersOf(sent, null, SUPPORT), [SUPPORT], 'dan@venue.com', 'all')).toEqual({ to: [{ name: '', email: 'dan@venue.com' }], cc: [{ name: '', email: 'kate@venue.com' }] });
    // an outbound row with no From was still ours
    const logged = { type: 'email', direction: 'outbound', channel_metadata: { to: 'dan@venue.com' } };
    expect(replyDefaults(emailHeadersOf(logged, null, SUPPORT), [SUPPORT], '', 'reply').to.map((a) => a.email)).toEqual(['dan@venue.com']);
  });
  it('falls back to the customer email when there is no email to answer yet', () => {
    expect(replyDefaults(null, [SUPPORT], 'Dan@Venue.com', 'reply')).toEqual({ to: [{ name: '', email: 'dan@venue.com' }], cc: [] });
    expect(replyDefaults(null, [SUPPORT], SUPPORT, 'reply').to).toEqual([]);
  });
});

describe('what the composer sends', () => {
  const dan = { name: 'Dan', email: 'dan@venue.com' };
  it('adds a valid address still typed in the box, nobody twice', () => {
    const r = recipientsToSend({ to: [dan], toPending: 'ops@venue.com', cc: [{ name: '', email: 'dan@venue.com' }], ccPending: 'Kate <KATE@venue.com>' });
    expect(r.problem).toBe(null);
    expect(r.to.map((a) => a.email)).toEqual(['dan@venue.com', 'ops@venue.com']);
    expect(r.cc.map((a) => a.email)).toEqual(['kate@venue.com']);
  });
  it('refuses while typed text is not an address, or nobody is on To', () => {
    expect(recipientsToSend({ to: [dan], ccPending: 'kate@' }).problem).toMatch(/not an email address/);
    expect(recipientsToSend({ to: [], cc: [dan] }).problem).toMatch(/at least one/);
  });
  it('writes no dashes in what the user reads', () => {
    expect(recipientsToSend({ toPending: 'x' }).problem).not.toMatch(/[–—]/);
    expect(recipientsToSend({}).problem).not.toMatch(/[–—]/);
  });
});

describe('small display and keyboard rules', () => {
  it('formats a header for the email card', () => {
    expect(formatAddresses('"Lowe, Kate" <kate@venue.com>, ops@venue.com')).toBe('Lowe, Kate <kate@venue.com>, ops@venue.com');
    expect(formatAddresses(null)).toBe('');
  });
  it('Cmd or Ctrl with Enter sends; plain Enter, Shift+Enter and IME composition do not', () => {
    expect(isSendShortcut({ key: 'Enter', metaKey: true })).toBe(true);
    expect(isSendShortcut({ key: 'Enter', ctrlKey: true, nativeEvent: {} })).toBe(true);
    expect(isSendShortcut({ key: 'Enter' })).toBe(false);
    expect(isSendShortcut({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(isSendShortcut({ key: 'Enter', metaKey: true, nativeEvent: { isComposing: true } })).toBe(false);
  });
});

describe('review fixes', () => {
  const at = (min) => new Date(Date.UTC(2026, 8, 11, 10, min)).toISOString();
  it('skips our auto reply when picking the email a reply answers', () => {
    const rows = [
      { id: 'in', type: 'email', direction: 'inbound', channel_metadata: { from: 'kate@venue.com', cc: 'ops@venue.com' } },
      { id: 'auto', type: 'email', direction: 'outbound', channel_metadata: { auto_reply: true, to: 'kate@venue.com' } },
    ];
    expect(latestEmail(rows).id).toBe('in');
  });
  it('counts a new email that sorts just above the newest note, but not an old back dated call', () => {
    const prev = [{ id: 'n1', occurred_at: at(10) }];
    const rows = [{ id: 'call', occurred_at: at(0) - 0 }, { id: 'e1', occurred_at: at(9) }, { id: 'n1', occurred_at: at(10) }];
    rows[0].occurred_at = new Date(Date.UTC(2026, 8, 1)).toISOString();
    const prevIds = new Set(prev.map((r) => r.id));
    expect(arrivedAtBottom(prevIds, rows, newestAt(prev)).map((r) => r.id)).toEqual(['e1']);
    expect(arrivedAtBottom(prevIds, [...rows, { id: 'n2', occurred_at: at(11) }], newestAt(prev)).map((r) => r.id)).toEqual(['call', 'e1', 'n2']);
  });
  it('refuses a typed list with one bad address instead of sending to the good one only', () => {
    const r = recipientsToSend({ to: [], toPending: 'kate@venue.com, dan@venue' });
    expect(r.problem).toMatch(/dan@venue/);
    expect(r.to).toEqual([]);
  });
  it('refuses more than 20 people', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ name: '', email: `p${i}@venue.com` }));
    expect(recipientsToSend({ to: many }).problem).toMatch(/20/);
  });
});
