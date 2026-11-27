import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  minorUnits, fromMinorUnits, checkoutBase, paymentSplits,
  storeFor, statementName, currencyList, paymentLinkBody, linkIdempotencyKey, shortHash, createPaymentLink,
} from '../../supabase/functions/_shared/adyen.ts';
import {
  isTrue, signedPayload, plainSignedPayload, hexToBytes, verifyItem,
  invoiceReference, invoiceIdFromReference, decide,
} from '../../supabase/functions/_shared/adyenWebhook.ts';

const INV = '7ec5b68b-348f-436a-875b-bad043d061c2';
const item = (o = {}) => ({
  pspReference: 'A1B2C3D4E5F6G7H8', merchantAccountCode: 'ServOSCOM', merchantReference: invoiceReference(INV),
  amount: { currency: 'GBP', value: 29880 }, eventCode: 'AUTHORISATION', success: 'true', ...o,
});

describe('money in minor units', () => {
  it('turns pounds into whole pennies', () => {
    expect(minorUnits(298.8)).toBe(29880);
    expect(minorUnits('298.80')).toBe(29880);
    expect(minorUnits(0.01)).toBe(1);
  });

  it('survives the floats that lose a penny', () => {
    expect(minorUnits(29.07)).toBe(2907);   // 29.07 * 100 is 2906.9999999999995
    expect(minorUnits(1.005)).toBe(101);
    expect(minorUnits(1234.56)).toBe(123456);
  });

  it('comes back as money', () => {
    expect(fromMinorUnits(29880)).toBe(298.8);
    expect(fromMinorUnits(1)).toBe(0.01);
  });

  it('refuses nonsense rather than charging something odd', () => {
    for (const bad of ['', 'abc', null, undefined, NaN]) expect(() => minorUnits(bad)).toThrow();
  });
});

describe('which Adyen we are talking to', () => {
  it('uses the plain test host', () => {
    expect(checkoutBase('test', undefined)).toBe('https://checkout-test.adyen.com/v71');
    expect(checkoutBase(undefined, undefined)).toBe('https://checkout-test.adyen.com/v71');
  });

  it('builds live with the prefix AND the extra /checkout/ segment', () => {
    // Live is not the test host with a word swapped. Both differences matter.
    expect(checkoutBase('live', '1797a841fbb37ca7-ServOS'))
      .toBe('https://1797a841fbb37ca7-ServOS-checkout-live.adyenpayments.com/checkout/v71');
    expect(checkoutBase('LIVE', '  1797a841fbb37ca7-ServOS  ')).toContain('/checkout/v71');
  });

  it('refuses live with no prefix instead of calling a host that does not exist', () => {
    expect(() => checkoutBase('live', '')).toThrow(/ADYEN_LIVE_PREFIX/);
  });
});

describe('the signature', () => {
  it('matches the example Adyen publishes', async () => {
    // From Adyen's HMAC docs: key 44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056
    // over 7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true
    const docItem = {
      pspReference: '7914073381342284', merchantAccountCode: 'TestMerchant',
      merchantReference: 'TestPayment-1407325143704', amount: { currency: 'EUR', value: 1130 },
      eventCode: 'AUTHORISATION', success: 'true',
      additionalData: { hmacSignature: 'coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=' },
    };
    expect(plainSignedPayload(docItem)).toBe('7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true');
    expect(await verifyItem(docItem, ['44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056'])).toBe(true);
  });

  it('leaves two colons where a field is absent', () => {
    expect(signedPayload(item())).toContain('A1B2C3D4E5F6G7H8::ServOSCOM:');
  });

  it('signs the minor units, not the pounds', () => {
    expect(signedPayload(item())).toContain(':29880:GBP:');
    expect(signedPayload(item())).not.toContain('298.8');
  });

  it('refuses an item with no signature at all', async () => {
    expect(await verifyItem(item(), ['00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF'])).toBe(false);
  });

  it('refuses when no key is configured', async () => {
    expect(await verifyItem({ ...item(), additionalData: { hmacSignature: 'x' } }, [])).toBe(false);
  });

  it('says a hex key that is not hex is wrong, loudly', () => {
    expect(() => hexToBytes('not-hex')).toThrow(/hex/);
    expect(() => hexToBytes('ABC')).toThrow();
    expect(hexToBytes('00ff').length).toBe(2);
  });
});

describe('Adyen booleans are strings', () => {
  it('reads "true" and "false" properly', () => {
    expect(isTrue('true')).toBe(true);
    expect(isTrue(true)).toBe(true);
    expect(isTrue('false')).toBe(false);
    expect(isTrue(false)).toBe(false);
    // The bug this guards: Boolean("false") is true.
    expect(Boolean('false')).toBe(true);
  });
});

describe('our reference', () => {
  it('goes out and comes back as the same invoice', () => {
    expect(invoiceIdFromReference(invoiceReference(INV))).toBe(INV);
  });

  it('contains nothing that could break the signing string', () => {
    expect(invoiceReference(INV)).toMatch(/^inv-[0-9a-f-]+$/);
  });

  it('refuses a reference that is not ours', () => {
    for (const bad of ['', 'inv-nope', 'PL61C53A8B97E6915A', `inv-${INV}-2`, null]) {
      expect(invoiceIdFromReference(bad)).toBeNull();
    }
  });
});

describe('what a notification means', () => {
  it('takes the money on a successful authorisation', () => {
    expect(decide(item())).toEqual({ action: 'pay', invoiceId: INV, amount: 298.8, currency: 'GBP', psp: 'A1B2C3D4E5F6G7H8' });
  });

  it('never waits for a capture that will not come', () => {
    // Pay by Link captures automatically, and an automatic capture is silent.
    expect(decide(item({ eventCode: 'CAPTURE' })).action).toBe('ignore');
  });

  it('treats a failed attempt as a note, because they can try again', () => {
    const d = decide(item({ success: 'false', reason: 'Refused' }));
    expect(d.action).toBe('note');
    expect(d.note).toMatch(/Refused/);
  });

  it('records the walk away that nobody heard about on 14 Oct', () => {
    expect(decide(item({ eventCode: 'OFFER_CLOSED', success: 'false' })).action).toBe('note');
  });

  it('ignores a payment that belongs to someone else', () => {
    expect(decide(item({ merchantReference: 'someone-elses-ref' })).action).toBe('ignore');
  });

  it('ignores an authorisation with no money on it', () => {
    expect(decide(item({ amount: { currency: 'GBP', value: 0 } })).action).toBe('ignore');
  });

  it('keeps refunds and chargebacks as notes, never as payments', () => {
    for (const code of ['REFUND', 'REFUND_FAILED', 'REFUNDED_REVERSED', 'CHARGEBACK']) {
      expect(decide(item({ eventCode: code })).action).toBe('note');
    }
  });
});

describe('where the money goes', () => {
  const BA = 'BA32C5F22322CJ5PXF2BD7FKK';
  const cfg = (o = {}) => ({ apiKey: 'k', merchantAccount: 'FranPOS_QSR_UK', env: 'live', balanceAccount: BA, ...o });

  it('sends the whole sale to our own balance account', () => {
    const splits = paymentSplits(cfg(), 298.8, 'GBP', 'inv-x');
    const net = splits.find((s) => s.type === 'BalanceAccount');
    expect(net.account).toBe(BA);
    expect(net.amount).toEqual({ value: 29880, currency: 'GBP' });
    expect(net.reference).toBe('inv-x-net');
  });

  it('takes no commission, because commission goes to the reseller', () => {
    // Peter, 14 Oct: no commission of any kind on ServOS's own sales. On a
    // balance platform a Commission split always books to the LIABLE account,
    // which here is FranPOS, so the split must simply not exist.
    const splits = paymentSplits(cfg(), 298.8, 'GBP', 'inv-x');
    expect(splits.some((s) => s.type === 'Commission')).toBe(false);
    expect(splits.find((s) => s.type === 'BalanceAccount').amount.value).toBe(minorUnits(298.8));
  });

  it('puts the card cost on us, with no amount, as Adyen requires', () => {
    const fee = paymentSplits(cfg(), 100, 'GBP', 'inv-x').find((s) => s.type === 'PaymentFee');
    expect(fee).toEqual({ type: 'PaymentFee', account: BA, reference: 'inv-x-fee' });
    expect(fee.amount).toBeUndefined();
  });

  it('can leave the card cost with the platform if we ever want that', () => {
    const splits = paymentSplits(cfg({ feesOnUs: false }), 100, 'GBP', 'inv-x');
    expect(splits.some((s) => s.type === 'PaymentFee')).toBe(false);
    expect(splits).toHaveLength(1);
  });

  it('sends no splits at all when no balance account is configured', () => {
    expect(paymentSplits(cfg({ balanceAccount: undefined }), 100, 'GBP', 'inv-x')).toBeNull();
  });

  it('uses the payment currency, so a US sale is not booked in pounds', () => {
    const net = paymentSplits(cfg(), 1200, 'usd', 'inv-y').find((s) => s.type === 'BalanceAccount');
    expect(net.amount).toEqual({ value: 120000, currency: 'USD' });
  });
});

// 27 Nov 2026. Three invoices went out with no store. Adyen ran them as the
// reseller's own (US) merchant account: the payer's statement said the
// reseller's name and UK Visa cards cost 4.35% (interchange 2.00%, scheme fees
// 2.28%), against 0.46% for the same account's online payments that name a store.
describe('our own store, so the payer sees our name and the card is priced as a home sale', () => {
  const BA = 'BA32C5F22322CJ5PXF2BD7FKK';
  const cfg = (o = {}) => ({ apiKey: 'k', merchantAccount: 'FranPOS_QSR_UK', env: 'live', balanceAccount: BA, ...o });
  const INVREF = 'inv-7315f047-8c77-4392-9d0b-a9866265071d';
  const input = (o = {}) => ({ amount: 3423.48, currency: 'GBP', reference: INVREF, ...o });
  const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);

  it('names the store on the link when one is set', () => {
    const body = paymentLinkBody(cfg({ store: 'SERVOS-CRM' }), input(), NOW);
    expect(body.store).toBe('SERVOS-CRM');
  });

  it('sends no store when none is set, exactly as before', () => {
    const body = paymentLinkBody(cfg(), input(), NOW);
    expect('store' in body).toBe(false);
    expect('shopperStatement' in body).toBe(false);
    expect(body).toEqual({
      merchantAccount: 'FranPOS_QSR_UK', reference: INVREF,
      amount: { currency: 'GBP', value: 342348 },
      expiresAt: '2026-12-27T12:00:00+00:00', reusable: false,
      splits: [
        { type: 'BalanceAccount', account: BA, amount: { value: 342348, currency: 'GBP' }, reference: `${INVREF}-net` },
        { type: 'PaymentFee', account: BA, reference: `${INVREF}-fee` },
      ],
      platformChargebackLogic: { behavior: 'deductFromOneBalanceAccount', targetAccount: BA },
    });
  });

  it('still sends our own splits with the store, so the store profile takes no commission', () => {
    // Adyen: a split instruction in the request overrides the store's automatic split.
    const body = paymentLinkBody(cfg({ store: 'SV-1007' }), input(), NOW);
    expect(body.store).toBe('SV-1007');
    expect(body.splits.map((s) => s.type)).toEqual(['BalanceAccount', 'PaymentFee']);
    expect(body.splits.some((s) => s.type === 'Commission')).toBe(false);
    expect(body.splits[0].amount.value).toBe(342348);   // the whole sale, nothing held back
  });

  it('keeps the store to the currencies it is for', () => {
    const c = cfg({ store: 'SERVOS-CRM', storeCurrencies: ['GBP'] });
    expect(storeFor(c, 'GBP')).toBe('SERVOS-CRM');
    expect(storeFor(c, 'gbp')).toBe('SERVOS-CRM');
    expect(storeFor(c, 'USD')).toBeNull();
    expect('store' in paymentLinkBody(c, input({ currency: 'USD' }), NOW)).toBe(false);
  });

  it('uses the store for every currency when no list is given', () => {
    expect(storeFor(cfg({ store: 'SERVOS-CRM' }), 'USD')).toBe('SERVOS-CRM');
    expect(storeFor(cfg({ store: 'SERVOS-CRM', storeCurrencies: [] }), 'EUR')).toBe('SERVOS-CRM');
  });

  it('never sends a store Adyen would refuse, because a refused link takes no money', () => {
    expect(storeFor(cfg({ store: 'ST32DDL22322BQ5PXJVN95JSM' }), 'GBP')).toBeNull();   // an id, not a reference: over 16
    expect(storeFor(cfg({ store: 'SERVOS CRM' }), 'GBP')).toBeNull();
    expect(storeFor(cfg({ store: '   ' }), 'GBP')).toBeNull();
    expect(storeFor(cfg(), 'GBP')).toBeNull();
  });

  it('reads the currency list however it is typed', () => {
    expect(currencyList('gbp, usd')).toEqual(['GBP', 'USD']);
    expect(currencyList('GBP')).toEqual(['GBP']);
    expect(currencyList('')).toEqual([]);
    expect(currencyList(undefined)).toEqual([]);
    expect(currencyList('pounds')).toEqual([]);
  });

  it('puts our name on the statement', () => {
    const body = paymentLinkBody(cfg({ store: 'SERVOS-CRM', shopperStatement: 'ServOS' }), input(), NOW);
    expect(body.shopperStatement).toBe('ServOS');
  });

  it('cleans the statement name to what a bank will print', () => {
    expect(statementName('ServOS')).toBe('ServOS');
    expect(statementName('  Serv\u2011OS  Ltd! ')).toBe('ServOS Ltd');
    expect(statementName('Point of Sale Unified Partners Limited')).toBe('Point of Sale Unified');   // 22 at most
    expect(statementName('12345')).toBe('');     // never numbers alone
    expect(statementName('')).toBe('');
    expect(statementName(null)).toBe('');
  });

  it('keeps the old link key when nothing is set', () => {
    expect(linkIdempotencyKey(cfg(), input())).toBe(`link-${INVREF}-342348-GBP`);
  });

  it('makes a new key once the store is set, so last week\'s storeless link is not replayed', () => {
    const before = linkIdempotencyKey(cfg(), input());
    const withStore = linkIdempotencyKey(cfg({ store: 'SERVOS-CRM' }), input());
    const withName = linkIdempotencyKey(cfg({ store: 'SERVOS-CRM', shopperStatement: 'ServOS' }), input());
    const otherStore = linkIdempotencyKey(cfg({ store: 'SV-1007' }), input());
    expect(new Set([before, withStore, withName, otherStore]).size).toBe(4);
    expect(linkIdempotencyKey(cfg({ store: 'SERVOS-CRM' }), input())).toBe(withStore);   // steady
  });

  it('leaves the key alone for a currency the store is not for', () => {
    const c = cfg({ store: 'SERVOS-CRM', storeCurrencies: ['GBP'] });
    expect(linkIdempotencyKey(c, input({ currency: 'USD' }))).toBe(`link-${INVREF}-342348-USD`);
  });

  it('stays inside Adyen\'s 64 character key, even on a very large invoice', () => {
    const c = cfg({ store: 'SERVOS-CRM-LONG1', shopperStatement: 'ServOS Hospitality Ltd' });
    expect(linkIdempotencyKey(c, input({ amount: 999999.99 })).length).toBeLessThanOrEqual(64);
    expect(shortHash('a')).toHaveLength(5);
    expect(shortHash('a')).not.toBe(shortHash('b'));
  });
});

describe('a customer can always pay, even if Adyen refuses our store', () => {
  const BA = 'BA32C5F22322CJ5PXF2BD7FKK';
  const cfg = (o = {}) => ({ apiKey: 'k', merchantAccount: 'FranPOS_QSR_UK', env: 'test', balanceAccount: BA, ...o });
  const input = { amount: 100, currency: 'GBP', reference: 'inv-7315f047-8c77-4392-9d0b-a9866265071d', metadata: { invoice_number: '1023' } };
  const reply = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('makes one call when the store is accepted', async () => {
    const fetchMock = vi.fn(async () => reply(201, { id: 'PL1', url: 'https://pay/1' }));
    vi.stubGlobal('fetch', fetchMock);
    const link = await createPaymentLink(cfg({ store: 'SV-1007' }), input);
    expect(link.url).toBe('https://pay/1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).store).toBe('SV-1007');
  });

  it('makes the link again with no store when Adyen refuses the store', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(422, { status: 422, errorCode: '910', message: 'Invalid Store' }))
      .mockResolvedValueOnce(reply(201, { id: 'PL2', url: 'https://pay/2' }));
    vi.stubGlobal('fetch', fetchMock);
    const link = await createPaymentLink(cfg({ store: 'GONE' }), input);
    expect(link.url).toBe('https://pay/2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect('store' in second).toBe(false);
    expect(second.metadata).toEqual({ invoice_number: '1023', store_refused: 'GONE' });
    expect(second.splits.map((s) => s.type)).toEqual(['BalanceAccount', 'PaymentFee']);
    // a different key, so Adyen does not replay the refusal
    expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).not.toBe(fetchMock.mock.calls[0][1].headers['Idempotency-Key']);
    expect(console.error).toHaveBeenCalled();
  });

  it('does not try twice when there was no store to blame', async () => {
    const fetchMock = vi.fn(async () => reply(422, { message: 'bad amount' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createPaymentLink(cfg(), input)).rejects.toThrow(/bad amount/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not hide an Adyen outage behind a second call', async () => {
    const fetchMock = vi.fn(async () => reply(503, { message: 'down' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createPaymentLink(cfg({ store: 'SV-1007' }), input)).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
