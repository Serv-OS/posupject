import { describe, it, expect, vi, beforeEach } from 'vitest';

// A small in-memory Supabase: enough of the query builder for the inventory
// moves, with a real await between steps so two calls can interleave the way
// two clicks do in a browser.
const { db, reset } = vi.hoisted(() => {
  const db = { inv_serials: [], inv_movements: [], locations: [], companies: [] };
  const reset = (seed) => { for (const k of Object.keys(db)) db[k] = (seed[k] || []).map(r => ({ ...r })); };
  return { db, reset };
});

vi.mock('./supabase', () => {
  const tick = () => new Promise(r => setTimeout(r, 0));
  const from = (table) => {
    const filters = [];
    let op = 'select', patch = null, row = null, cols = '*', returning = false, single = false;
    const embed = (r) => {
      const out = { ...r };
      if (cols.includes('company:companies')) {
        const c = db.companies.find(x => x.id === r.company_id);
        out.company = c ? { name: c.name } : null;
      }
      if (cols.includes('location:locations')) {
        const l = db.locations.find(x => x.id === r.location_id);
        out.location = l ? { name: l.name } : null;
      }
      return out;
    };
    const run = async () => {
      await tick();
      const t = db[table];
      if (op === 'insert') {
        (Array.isArray(row) ? row : [row]).forEach(x => t.push({ id: `${table}-${t.length + 1}`, ...x }));
        return { data: null, error: null };
      }
      const hits = t.filter(r => filters.every(f => f(r)));
      if (op === 'update') {
        hits.forEach(r => Object.assign(r, patch));
        return { data: returning ? hits.map(embed) : null, error: null };
      }
      const data = hits.map(embed);
      return { data: single ? (data[0] ?? null) : data, error: null };
    };
    const api = {
      select(c) { if (op === 'select') cols = c || '*'; else { returning = true; cols = c || '*'; } return api; },
      insert(r) { op = 'insert'; row = r; return api; },
      update(p) { op = 'update'; patch = p; return api; },
      eq(c, v) { filters.push(r => r[c] === v); return api; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return api; },
      is(c, v) { filters.push(r => (r[c] ?? null) === v); return api; },
      order() { return api; },
      limit() { return api; },
      maybeSingle() { single = true; return api; },
      then(ok, bad) { return run().then(ok, bad); },
    };
    return api;
  };
  return { supabase: { from } };
});

import {
  stockOut, stageUnits, moveUnits, targetFor, whereLabel, companyLabel, siteLabel, sitesOf, missingSite,
  recallToServicing, resolveServicing, dispatchRmaTl, notMoved, siteFirstLabel, movementWhere, moveTypeLabel,
} from './inventoryOps';

const COFFEE_BOY = 'co-coffeeboy';
const TDNZ = 'co-tdnz';
const STATION = 'loc-station';   // belongs to TDNZ
const LEEDS = 'loc-leeds';       // belongs to Coffee Boy
const unit = (serial, product, o = {}) => ({
  serial, product_name: product, category: null, status: 'in_stock', company_id: null, location_id: null,
  customer_name: null, dispatch_ref: null, deployed_at: null, warehouse_id: 'wh1', ...o,
});
const seed = (units) => reset({
  companies: [{ id: COFFEE_BOY, name: 'Coffee Boy Retail' }, { id: TDNZ, name: 'TDNZ COFFEE LTD' }],
  locations: [
    { id: STATION, name: 'Coffee Boy - Barnsley Train Station', company_id: TDNZ },
    { id: LEEDS, name: 'Coffee Boy - Leeds', company_id: COFFEE_BOY },
  ],
  inv_serials: units,
});
const serial = (s) => db.inv_serials.find(r => r.serial === s);
const BY = { byName: 'Peter', actorId: 'p1' };

beforeEach(() => seed([]));

describe('where a unit is', () => {
  it('names the company and the site, not one in place of the other', () => {
    const r = { company: { name: 'TDNZ COFFEE LTD' }, location: { name: 'Barnsley Train Station' } };
    expect(whereLabel(r)).toBe('TDNZ COFFEE LTD · Barnsley Train Station');
    expect(companyLabel(r)).toBe('TDNZ COFFEE LTD');
    expect(siteLabel(r)).toBe('Barnsley Train Station');
  });

  it('still names the company when there is no site', () => {
    expect(whereLabel({ company: { name: 'Coffee Boy Retail' }, location: null })).toBe('Coffee Boy Retail');
  });

  it('falls back to the free text name, then a dash', () => {
    expect(whereLabel({ customer_name: 'Pop up stall' })).toBe('Pop up stall');
    expect(whereLabel({})).toBe('—');
  });
});

describe('who a unit goes to', () => {
  it('lets the site decide the company, so they can never disagree', () => {
    const t = targetFor({ id: STATION, company_id: TDNZ }, { companyId: COFFEE_BOY, locationId: STATION });
    expect(t).toEqual({ company_id: TDNZ, location_id: STATION, customer_name: null });
  });

  it('keeps the picked company when the site has none', () => {
    expect(targetFor({ id: 'x', company_id: null }, { companyId: TDNZ, locationId: 'x' }).company_id).toBe(TDNZ);
  });

  it('refuses a site that has gone', () => {
    expect(() => targetFor(null, { locationId: STATION })).toThrow(/no longer exists/);
  });

  it('books a company with no site, and drops stray free text', () => {
    expect(targetFor(null, { companyId: TDNZ, customerName: 'left over' }))
      .toEqual({ company_id: TDNZ, location_id: null, customer_name: null });
  });

  it('takes free text only when nothing in the CRM is picked', () => {
    expect(targetFor(null, { customerName: '  Pop up stall ' }).customer_name).toBe('Pop up stall');
    expect(() => targetFor(null, {})).toThrow(/Pick a site or a customer/);
    expect(() => targetFor(null, { customerName: '   ' })).toThrow();
  });
});

describe('the site warning', () => {
  const locs = [{ id: STATION, company_id: TDNZ }];
  it('warns when the company has sites but none is picked', () => {
    expect(missingSite(locs, TDNZ, '')).toBe(true);
    expect(missingSite(locs, TDNZ, STATION)).toBe(false);
  });
  it('stays quiet for a company with no sites, or no company', () => {
    expect(missingSite(locs, COFFEE_BOY, '')).toBe(false);
    expect(missingSite(locs, '', '')).toBe(false);
    expect(sitesOf(locs, TDNZ)).toHaveLength(1);
  });
});

describe('stock out', () => {
  it('books straight to a site and its company', async () => {
    seed([unit('A1', 'TV Menu Stick'), unit('A2', 'TV Menu Stick')]);
    await stockOut({ serials: ['a1', 'A2'], locationId: STATION, ref: 'CB Barnsley Train Station', ...BY });
    expect(serial('A1')).toMatchObject({ status: 'deployed', company_id: TDNZ, location_id: STATION, warehouse_id: null });
    expect(db.inv_movements).toHaveLength(1);
    expect(db.inv_movements[0]).toMatchObject({ type: 'out', qty: 2, company_id: TDNZ, location_id: STATION });
  });

  it('refuses a unit that is not in stock', async () => {
    seed([unit('A1', 'Router', { status: 'deployed' })]);
    await expect(stockOut({ serials: ['A1'], companyId: TDNZ, ...BY })).rejects.toThrow(/Not in stock: A1/);
    expect(db.inv_movements).toHaveLength(0);
  });

  it('dispatches staged kit once, however many times confirm is pressed', async () => {
    // 16 Oct: confirm put staged units back to in_stock and re-dispatched
    // them, so a double click booked every unit out twice.
    const staged = { status: 'staged', company_id: TDNZ, location_id: STATION };
    seed([unit('S1', 'Sunmi D3 Pro', staged), unit('S2', 'Card Reader', staged)]);
    const go = () => stockOut({ serials: ['S1', 'S2'], companyId: TDNZ, locationId: STATION, from: ['staged'], ...BY });
    const results = await Promise.allSettled([go(), go()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.message).toMatch(/someone else moved them first/);
    expect(db.inv_movements.filter(m => m.type === 'out')).toHaveLength(2); // one per product, once
    expect(serial('S1').status).toBe('deployed');
  });

  it('never dispatches in-stock kit while confirming staged kit', async () => {
    seed([unit('S1', 'Router')]);
    await expect(stockOut({ serials: ['S1'], companyId: TDNZ, from: ['staged'], ...BY })).rejects.toThrow(/Not staged: S1/);
    expect(serial('S1').status).toBe('in_stock');
  });
});

describe('staging', () => {
  it('only stages what is in stock', async () => {
    seed([unit('A1', 'Router'), unit('A2', 'Router', { status: 'deployed', company_id: COFFEE_BOY })]);
    await expect(stageUnits({ serials: ['A1', 'A2'], locationId: STATION })).rejects.toThrow(/Could not stage A2/);
    expect(serial('A1')).toMatchObject({ status: 'staged', company_id: TDNZ, location_id: STATION });
    expect(serial('A2')).toMatchObject({ status: 'deployed', company_id: COFFEE_BOY });
  });
});

describe('moving kit that is out on site', () => {
  const at = { status: 'deployed', company_id: COFFEE_BOY, dispatch_ref: 'Barnsley STN', deployed_at: '2026-10-16T04:16:26Z' };

  it('moves the Barnsley units to the right company and site, keeping the install date', async () => {
    seed([unit('X1', 'TV Menu Stick', at), unit('X2', 'TV Menu Stick', at), unit('R1', 'Unifi UX7 Router', at)]);
    await moveUnits({ serials: ['X1', 'X2', 'R1'], locationId: STATION, ref: 'CB Barnsley Train Station', ...BY });
    for (const s of ['X1', 'X2', 'R1']) {
      expect(serial(s)).toMatchObject({
        status: 'deployed', company_id: TDNZ, location_id: STATION,
        dispatch_ref: 'CB Barnsley Train Station', deployed_at: '2026-10-16T04:16:26Z',
      });
    }
    const lines = db.inv_movements;
    expect(lines.map(m => m.type)).toEqual(['transfer', 'transfer']);
    expect(lines.find(m => m.product_name === 'TV Menu Stick')).toMatchObject({
      qty: 2, company_id: TDNZ, location_id: STATION, ref: 'CB Barnsley Train Station',
      notes: 'Moved from Coffee Boy Retail', by_name: 'Peter',
    });
  });

  it('says which site the kit came from', async () => {
    seed([unit('L1', 'Card Reader', { ...at, location_id: LEEDS })]);
    await moveUnits({ serials: ['L1'], locationId: STATION, ...BY });
    expect(db.inv_movements[0].notes).toBe('Moved from Coffee Boy Retail · Coffee Boy - Leeds');
  });

  it('keeps each unit its own ref when no ref is given, and history says so per unit', async () => {
    seed([unit('K1', 'Router', at), unit('K2', 'Router', { ...at, dispatch_ref: 'Job 7' })]);
    await moveUnits({ serials: ['K1', 'K2'], locationId: STATION, ...BY });
    expect(serial('K1').dispatch_ref).toBe('Barnsley STN');
    expect(serial('K2').dispatch_ref).toBe('Job 7');
    const lines = db.inv_movements.map(m => [m.serials.join(), m.ref]).sort();
    expect(lines).toEqual([['K1', 'Barnsley STN'], ['K2', 'Job 7']]);
  });

  it('writes nothing for units already where they are going', async () => {
    seed([unit('A1', 'TV Menu Stick', at), unit('A2', 'TV Menu Stick', { ...at, company_id: TDNZ, location_id: STATION })]);
    await moveUnits({ serials: ['A1', 'A2'], locationId: STATION, ...BY });
    expect(db.inv_movements).toHaveLength(1);
    expect(db.inv_movements[0]).toMatchObject({ serials: ['A1'], qty: 1, notes: 'Moved from Coffee Boy Retail' });
  });

  it('is a quiet no-op when every unit is already there', async () => {
    seed([unit('A2', 'TV Menu Stick', { ...at, company_id: TDNZ, location_id: STATION })]);
    await expect(moveUnits({ serials: ['A2'], locationId: STATION, ...BY })).resolves.toEqual([]);
    expect(db.inv_movements).toHaveLength(0);
  });

  it('splits history by where each unit came from', async () => {
    seed([unit('P1', 'Router', at), unit('P2', 'Router', { ...at, location_id: LEEDS })]);
    await moveUnits({ serials: ['P1', 'P2'], locationId: STATION, ref: 'Job 9', ...BY });
    expect(db.inv_movements.map(m => m.notes).sort())
      .toEqual(['Moved from Coffee Boy Retail', 'Moved from Coffee Boy Retail · Coffee Boy - Leeds']);
  });

  it('leaves a unit alone that someone else moved since the screen loaded', async () => {
    // The site page still lists U1 as having no site, but another page has
    // just put it on Leeds. Put it here must not take it off Leeds.
    seed([unit('U1', 'Router', { ...at, location_id: LEEDS }), unit('U2', 'Router', at)]);
    const expected = { U1: { company_id: COFFEE_BOY, location_id: null }, U2: { company_id: COFFEE_BOY, location_id: null } };
    const err = await moveUnits({ serials: ['U1', 'U2'], locationId: STATION, expected, ...BY }).catch(e => e);
    expect(err.message).toMatch(/^Moved 1 of 2\. Could not move U1: someone else moved it first/);
    expect(err.moved.map(m => m.serial)).toEqual(['U2']);
    expect(serial('U1').location_id).toBe(LEEDS);
    expect(serial('U2').location_id).toBe(STATION);
  });

  it('lets only one of two racing moves win', async () => {
    seed([unit('R1', 'Router', at)]);
    const results = await Promise.allSettled([
      moveUnits({ serials: ['R1'], locationId: STATION, ...BY }),
      moveUnits({ serials: ['R1'], locationId: LEEDS, ...BY }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.inv_movements).toHaveLength(1);
    expect(db.inv_movements[0].location_id).toBe(serial('R1').location_id);
  });

  it('clears the ref when an empty one is given', async () => {
    seed([unit('K1', 'Router', at)]);
    await moveUnits({ serials: ['K1'], locationId: STATION, ref: '  ', ...BY });
    expect(serial('K1').dispatch_ref).toBeNull();
  });

  it('moves staged kit and leaves it staged', async () => {
    seed([unit('G1', 'Router', { ...at, status: 'staged' })]);
    await moveUnits({ serials: ['G1'], companyId: TDNZ, ...BY });
    expect(serial('G1')).toMatchObject({ status: 'staged', company_id: TDNZ, location_id: null });
  });

  it('refuses kit that is in our hands', async () => {
    seed([unit('W1', 'Router'), unit('W2', 'Router', at)]);
    await expect(moveUnits({ serials: ['W1', 'W2'], locationId: STATION, ...BY }))
      .rejects.toThrow(/out with a customer can be moved: W1 \(in stock\)/);
    expect(serial('W2').company_id).toBe(COFFEE_BOY);
    expect(db.inv_movements).toHaveLength(0);
  });

  it('refuses a serial it has never heard of', async () => {
    await expect(moveUnits({ serials: ['NOPE'], locationId: STATION, ...BY })).rejects.toThrow(/Not in the system: NOPE/);
  });

  it('needs somewhere to move to', async () => {
    seed([unit('W2', 'Router', at)]);
    await expect(moveUnits({ serials: ['W2'], ...BY })).rejects.toThrow(/Pick a site or a customer/);
  });
});

describe('the other stock changes only act once', () => {
  it('recalls a unit once, however many times recall is pressed', async () => {
    seed([unit('C1', 'Card Reader', { status: 'deployed', company_id: TDNZ, location_id: STATION })]);
    const go = () => recallToServicing({ serial: 'C1', warehouse: 'wh1', ...BY });
    const results = await Promise.allSettled([go(), go()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.inv_movements.filter(m => m.type === 'recall')).toHaveLength(1);
    expect(serial('C1').status).toBe('servicing');
  });

  it('resolves a servicing unit once', async () => {
    seed([unit('C2', 'Card Reader', { status: 'servicing' })]);
    const results = await Promise.allSettled([
      resolveServicing({ serial: 'C2', outcome: 'pass', warehouse: 'wh1' }),
      resolveServicing({ serial: 'C2', outcome: 'rma' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('only sends RMA or total loss kit back to the supplier', async () => {
    seed([unit('C3', 'Card Reader', { status: 'deployed', company_id: TDNZ })]);
    await expect(dispatchRmaTl({ serial: 'C3', type: 'rma', ...BY })).rejects.toThrow(/not waiting to go back/);
    expect(serial('C3').status).toBe('deployed');
    expect(db.inv_movements).toHaveLength(0);
  });
});

describe('messages and labels', () => {
  it('says what did happen when only some units changed', () => {
    const err = notMoved(['A', 'B', 'C'], [{ serial: 'A' }], 'dispatch');
    expect(err.message).toBe('Dispatched 1 of 3. Could not dispatch B, C: someone else moved them first, or your login cannot change stock.');
    expect(err.moved).toEqual([{ serial: 'A' }]);
    expect(notMoved(['A'], [{ serial: 'A' }], 'move')).toBeNull();
    expect(notMoved(['A', 'B'], [], 'move', ['B']).message).toMatch(/^Moved 1 of 2\. Could not move A:/);
  });

  it('puts the site first where labels get cut off', () => {
    expect(siteFirstLabel({ company: { name: 'TDNZ COFFEE LTD' }, location: { name: 'Barnsley Train Station' } }))
      .toBe('Barnsley Train Station · TDNZ COFFEE LTD');
    expect(siteFirstLabel({ company: { name: 'TDNZ COFFEE LTD' } })).toBe('TDNZ COFFEE LTD');
  });

  it('names where a movement went, and calls a transfer a move', () => {
    expect(movementWhere({ company: { name: 'TDNZ COFFEE LTD' }, location: { name: 'Station' } })).toBe('TDNZ COFFEE LTD · Station');
    expect(movementWhere({ supplier_name: 'Sunmi' })).toBe('Sunmi');
    expect(moveTypeLabel('transfer')).toBe('moved');
    expect(moveTypeLabel('rma_out')).toBe('rma out');
  });
});
