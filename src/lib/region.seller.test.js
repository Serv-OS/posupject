import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'
vi.mock('./supabase', () => ({ supabase: {} }))
import { mergeSeller, registrationLine } from './region'

const settings = { business_name: 'ServOS App INC', business_address: '251 Little Falls Drive\nDelaware', invoice_terms: 'global terms', quote_terms: 'global quote' }
const regions = [
  { code: 'UK', currency: 'GBP', business_name: 'SERVOS APP LIMITED', business_address: null, invoice_terms: 'uk terms', quote_terms: null, company_number: '12345678', tax_number: 'GB123456789' },
  { code: 'US', currency: 'USD', business_name: 'ServOS App Inc', business_address: '251 Little Falls Drive', invoice_terms: 'us terms', quote_terms: 'us quote', company_number: null, tax_number: '12-3456789' },
]

describe('billing company per currency', () => {
  it('a pound document bills as the UK company with its registration', () => {
    const s = mergeSeller(settings, regions, 'GBP')
    expect(s.business_name).toBe('SERVOS APP LIMITED')
    expect(s.invoice_terms).toBe('uk terms')
    expect(s.quote_terms).toBe('global quote')
    // never the other company's (Delaware) address
    expect(s.business_address).toBe('Registered in England and Wales no. 12345678 · VAT no. GB123456789')
  })
  it('a dollar document bills as the US company with its EIN', () => {
    const s = mergeSeller(settings, regions, 'USD')
    expect(s.business_name).toBe('ServOS App Inc')
    expect(s.quote_terms).toBe('us quote')
    expect(s.business_address).toBe('251 Little Falls Drive\nEIN 12-3456789')
  })
  it('no registration fields, no line', () => {
    expect(registrationLine({ code: 'UK', currency: 'GBP' })).toBe(null)
  })
})
