import { describe, it, expect } from 'vitest';
import { minorUnits, fromMinorUnits, checkoutBase } from '../../supabase/functions/_shared/adyen.ts';
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
