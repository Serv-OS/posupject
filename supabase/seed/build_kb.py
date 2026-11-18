"""Turn the 'ServOS: every feature' markdown into kb_docs rows, plus hand-written
answers about the apps. Writes an idempotent SQL file (deletes its own rows first).

usage: python3 build_kb.py features.md out.sql
"""
import re, sys, json

src, out = sys.argv[1], sys.argv[2]
FEATURES_REF = 'servos-features-2026-11-15'
CORE_REF = 'servos-core-2026-11-18'

lines = open(src, encoding='utf-8').read().splitlines()
section = sub = None
rows = []
skip = False
for ln in lines:
    m = re.match(r'^## \*\*(.+?)\*\*', ln)
    if m:
        title = m.group(1)
        skip = title.startswith('What changed') or title.startswith('13 ')
        section = re.sub(r'^\d+\s+', '', title)
        sub = None
        continue
    m = re.match(r'^### \*\*(.+?)\*\*', ln)
    if m:
        sub = m.group(1)
        continue
    if skip or not section:
        continue
    m = re.match(r'^\s*-\s+\*\*(.+?)\*\*\s*(\([^)]*\))?\s*:\s*(.+)$', ln)
    if not m:
        continue
    name, body = m.group(1).strip(), m.group(3).strip()
    where = ''
    w = re.search(r'\s*Where:\s*(.+)$', body)
    if w:
        where = w.group(1).strip().rstrip('.')
        body = body[:w.start()].strip()
    body = body[0].upper() + body[1:] if body else body
    staff_only = bool(re.search(r'ServOS staff only|Admin portal', body + ' ' + where, re.I))
    answer = body + (f' Where to find it: {where}.' if where else '')
    question = f'{name}: does ServOS do this and where is it? ({sub or section})'
    rows.append(dict(title=name, question=question, answer=answer,
                     category=f'{section} / {sub}' if sub else section,
                     internal_only=staff_only, ref=FEATURES_REF))

CORE = [
    dict(title='Staff app for team members',
         question='Is there a staff app for team members to download from the App Store or Play Store, or is ServOS only web based? How do staff see rotas and clock in on their phone?',
         answer=('Yes, staff have the ServOS Staff app: shifts and rota, timesheets, clock in, holiday and availability, shift swaps, training and team chat. '
                 'It works on any phone today: open app.serv-os.app/?mode=staff in the phone browser, sign in with the email and password from the staff invite, '
                 'then use Add to Home Screen so it opens like an app. '
                 'Android: the ServOS Staff app can also be downloaded directly from https://tinyurl.com/233ga5kz (it is not on the Google Play Store yet, so the phone may ask to allow installs from the browser). '
                 'iPhone: the Staff app is not on the App Store yet, so use the browser and Add to Home Screen. '
                 'Managers send the invite from Back Office, Workforce, the person\'s staff record.'),
         category='Apps and devices'),
    dict(title='Which ServOS apps are on the App Store',
         question='Which ServOS apps can I download from the App Store or Google Play? Is there an iPad or iPhone app?',
         answer=('On the Apple App Store today: ServOS POS (https://apps.apple.com/gb/app/servos-pos/id6805131080) and ServOS KDS kitchen screen (https://apps.apple.com/gb/app/servos-kds/id6805150003). '
                 'The other apps (Staff, Manager, Owner, Time Clock, Kiosk, Waitlist and Bookings) run in any browser at app.serv-os.app and are on their way to the stores. '
                 'On Android they can be downloaded directly from a link the team can send; they are not on Google Play yet.'),
         category='Apps and devices'),
    dict(title='Is ServOS just a web app',
         question='Is ServOS just a web app? Does it need to be installed? What devices does it run on?',
         answer=('ServOS is a cloud system: the same live data on the till, kitchen screens, kiosks, phones and Back Office. '
                 'It runs on ServOS tills and card readers, iPads (ServOS POS and KDS are on the App Store), Android devices and any browser. '
                 'Back Office is at app.serv-os.app in any browser. Staff, managers and owners each have their own app (Staff, Manager, Owner) that works in the phone browser and can be added to the home screen.'),
         category='Apps and devices'),
    dict(title='Owner and Manager apps',
         question='Is there an app for owners or managers to see sales, approve shifts and check the venue on their phone?',
         answer=('Yes. The Owner app (sales, labour and the numbers across your sites) and the Manager app (today\'s trading, rota, approvals and stock) both work in the phone browser: '
                 'app.serv-os.app/?mode=owner and app.serv-os.app/?mode=manager. Sign in, then Add to Home Screen. '
                 'Android download links: Owner https://tinyurl.com/2yeddrv8 and Manager https://tinyurl.com/28lz2epj (not on Google Play yet).'),
         category='Apps and devices'),
    dict(title='Time Clock app',
         question='How do staff clock in and out? Is there a clock in app or tablet?',
         answer=('Staff clock in on the till with their PIN, on a Time Clock tablet, or in the Staff app on their phone (the Staff app checks they are at the venue when geofenced clock in is on). '
                 'The Time Clock runs at app.serv-os.app/?mode=clock on any tablet; on Android it can be downloaded from https://tinyurl.com/278wvz92.'),
         category='Apps and devices'),
]
for c in CORE:
    rows.append(dict(c, internal_only=False, ref=CORE_REF, first_line=True))

def lit(s):
    return "'" + str(s).replace("'", "''") + "'"

assert all('—' not in r['answer'] and '–' not in r['answer'] for r in rows if r['ref'] == CORE_REF)
with open(out, 'w', encoding='utf-8') as f:
    f.write('-- Support chat knowledge (ticket 1035, 18 Nov 2026). Safe to run twice:\n')
    f.write(f"-- it replaces only its own rows ({FEATURES_REF}, {CORE_REF}).\n")
    f.write('-- Needs migration 127 first (search index + kb_search).\nbegin;\n')
    f.write(f"delete from public.kb_docs where source = 'doc' and source_ref in ({lit(FEATURES_REF)}, {lit(CORE_REF)});\n")
    f.write('insert into public.kb_docs (source, source_ref, title, question, answer, category, internal_only, first_line) values\n')
    vals = [f"('doc', {lit(r['ref'])}, {lit(r['title'])}, {lit(r['question'])}, {lit(r['answer'])}, {lit(r['category'])}, {str(r['internal_only']).lower()}, {str(r.get('first_line', False)).lower()})" for r in rows]
    f.write(',\n'.join(vals) + ';\ncommit;\n')
    f.write("select source_ref, count(*), count(*) filter (where internal_only) staff_only from public.kb_docs where source = 'doc' group by 1;\n")
print(len(rows), 'rows;', sum(r['internal_only'] for r in rows), 'staff only;', sum(1 for r in rows if r['ref'] == CORE_REF), 'core')
