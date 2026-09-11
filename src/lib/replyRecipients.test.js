import { describe, it, expect } from 'vitest';
import { parseAddressList, buildReply, hasOtherRecipients, headerList, isValidEmail, stripCrlf, invalidAddresses, mailboxKey } from './replyRecipients.js';

const SUPPORT = 'support@posup.co.uk';

describe('parseAddressList', () => {
  it('keeps a quoted comma inside one display name', () => {
    expect(parseAddressList('"Smith, Jo" <Jo@Example.com>, sam@x.com')).toEqual([
      { name: 'Smith, Jo', email: 'jo@example.com' },
      { name: '', email: 'sam@x.com' },
    ]);
  });
  it('lowercases, de-duplicates and drops things that are not addresses', () => {
    expect(parseAddressList('A@X.com; a@x.com, not-an-email, <b@y.co.uk>').map((a) => a.email)).toEqual(['a@x.com', 'b@y.co.uk']);
  });
  it('reads nothing from an empty header', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
  });
});

describe('buildReply', () => {
  const inbound = { from: 'Dan <dan@venue.com>', to: `${SUPPORT}, ops@venue.com`, cc: 'Kate <kate@venue.com>, SUPPORT@posup.co.uk' };

  it('Reply goes to the sender only', () => {
    const r = buildReply(inbound, [SUPPORT], 'reply');
    expect(r.to.map((a) => a.email)).toEqual(['dan@venue.com']);
    expect(r.cc).toEqual([]);
  });
  it('Reply all copies everyone else, never our own mailbox, whatever its case', () => {
    const r = buildReply(inbound, [SUPPORT], 'all');
    expect(r.to.map((a) => a.email)).toEqual(['dan@venue.com']);
    expect(r.cc.map((a) => a.email)).toEqual(['ops@venue.com', 'kate@venue.com']);
  });
  it('Reply-To wins over From', () => {
    const r = buildReply({ ...inbound, replyTo: 'noreply-handler@venue.com' }, [SUPPORT], 'reply');
    expect(r.to.map((a) => a.email)).toEqual(['noreply-handler@venue.com']);
  });
  it('answering our OWN last message keeps the people we sent it to', () => {
    const outbound = { from: SUPPORT, to: 'dan@venue.com', cc: 'kate@venue.com' };
    expect(buildReply(outbound, [SUPPORT], 'reply')).toEqual({ to: [{ name: '', email: 'dan@venue.com' }], cc: [] });
    expect(buildReply(outbound, [SUPPORT], 'all').cc.map((a) => a.email)).toEqual(['kate@venue.com']);
  });
  it('never lists the same person on To and Cc', () => {
    const r = buildReply({ from: 'dan@venue.com', to: SUPPORT, cc: 'dan@venue.com, kate@venue.com' }, [SUPPORT], 'all');
    expect(r.cc.map((a) => a.email)).toEqual(['kate@venue.com']);
  });
  it('an old message with no stored To or Cc still replies to the sender', () => {
    expect(buildReply({ from: 'dan@venue.com' }, [SUPPORT], 'all')).toEqual({ to: [{ name: '', email: 'dan@venue.com' }], cc: [] });
  });
});

describe('helpers', () => {
  it('only offers Reply all when it would reach someone extra', () => {
    expect(hasOtherRecipients({ from: 'dan@venue.com', to: SUPPORT }, [SUPPORT])).toBe(false);
    expect(hasOtherRecipients({ from: 'dan@venue.com', to: SUPPORT, cc: 'kate@venue.com' }, [SUPPORT])).toBe(true);
  });
  it('writes bare addresses for a header and strips line breaks', () => {
    expect(headerList([{ name: 'Kate', email: 'kate@venue.com' }, 'ops@venue.com', 'bad'])).toBe('kate@venue.com, ops@venue.com');
    expect(stripCrlf('a@x.com\r\nBcc: evil@x.com')).toBe('a@x.com Bcc: evil@x.com');
    expect(isValidEmail('a@x.com\nBcc: e@x.com')).toBe(false);
  });
});

describe('invalidAddresses', () => {
  it('names the mistyped part in a list that also has a good address, so the list can be refused', () => {
    expect(invalidAddresses('kate@venue.com, dan@venue')).toEqual(['dan@venue']);
  });
  it('does not flag a quoted comma in a display name, duplicates, or an empty list', () => {
    expect(invalidAddresses('"Smith, Jo" <jo@x.com>; jo@x.com')).toEqual([]);
    expect(invalidAddresses('')).toEqual([]);
  });
});

describe('own mailbox with a +tag', () => {
  it('never copies support+billing@ back in when the support mailbox is ours', () => {
    const msg = { from: 'kate@venue.com', to: 'support+billing@serv-os.app', cc: 'ops@venue.com' };
    const r = buildReply(msg, ['support@serv-os.app'], 'all');
    expect(r.to.map((a) => a.email)).toEqual(['kate@venue.com']);
    expect(r.cc.map((a) => a.email)).toEqual(['ops@venue.com']);
    expect(mailboxKey(' Support+X@Serv-OS.app')).toBe('support@serv-os.app');
  });
});
