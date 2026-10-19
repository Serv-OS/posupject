import { useId } from 'react';
import { sitesOf } from '../../lib/inventoryOps';

// Company and site, chosen together.
//
// The site list is never locked behind the company. Every site is offered,
// grouped under its company, with the picked company's sites first. Picking a
// site fills its company in, so kit can be booked straight to the place it is
// installed. On 16 Oct six Barnsley Train Station units went to the wrong
// company because the site box only listed the sites of the company already
// picked, and the right site belonged to a different one.

export default function TargetPicker({
  companies, locations, companyId, locationId, onChange,
  inputClass, labelClass, disabled = false, freeText = false,
}) {
  const id = useId();
  const names = new Map((companies || []).map(c => [c.id, c.name]));
  const own = companyId ? sitesOf(locations, companyId) : [];

  // Every site, grouped under its company: the picked company first, then the
  // rest by name, sites with no company last.
  const groups = new Map();
  (locations || []).forEach(l => {
    const key = l.company_id || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  });
  const rank = (key) => (key && key === companyId ? 0 : key ? 1 : 2);
  const ordered = [...groups.keys()].sort((a, b) =>
    rank(a) - rank(b) || String(names.get(a) || '').localeCompare(String(names.get(b) || '')));
  const groupLabel = (key) => !key ? 'No company'
    : key === companyId ? `${names.get(key) || 'This company'} (picked)` : (names.get(key) || 'Unknown company');

  const pickCompany = (cid) => {
    const site = (locations || []).find(l => l.id === locationId);
    onChange({ companyId: cid, locationId: site && site.company_id === cid ? locationId : '' });
  };
  const pickSite = (lid) => {
    const site = (locations || []).find(l => l.id === lid);
    onChange({ companyId: site?.company_id || companyId || '', locationId: lid });
  };

  const siteHint = companyId
    ? (own.length ? 'No site: whole company' : 'No site (this company has none yet)')
    : 'Pick a site (fills the company in)';

  return (
    <>
      <div>
        <label className={labelClass} htmlFor={`${id}-company`}>Customer (company)</label>
        <select id={`${id}-company`} className={inputClass} value={companyId} disabled={disabled}
          onChange={e => pickCompany(e.target.value)}>
          <option value="">{freeText ? 'Not in the CRM: type a name below' : 'Pick a company'}</option>
          {(companies || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <label className={labelClass} htmlFor={`${id}-site`}>Location (site)</label>
        <select id={`${id}-site`} className={inputClass} value={locationId} disabled={disabled}
          onChange={e => pickSite(e.target.value)}>
          <option value="">{siteHint}</option>
          {ordered.map(key => (
            <optgroup key={key || 'none'} label={groupLabel(key)}>
              {groups.get(key).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
    </>
  );
}
