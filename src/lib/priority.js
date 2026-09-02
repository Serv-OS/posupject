// Priority, in the words of POSUP Ways of Working (Rules of Engagement) v1.1,
// section 7 "Service levels".
//
// The doc numbers them P1 to P4. The database has always stored P0 to P3, so
// the two are OFF BY ONE: "P2" means high in the doc and standard in the CRM.
// Anyone setting a priority from the written policy was one level out, and a
// critical ticket could be logged as merely high.
//
// Rather than renumber live data on every ticket, task, project, feature
// request and form, the UI now shows the NAMES. A dropdown that says Critical,
// High, Standard, Low cannot be off by one, because there is no number left to
// misread. The stored value is untouched, so history, SLA policies and every
// existing report still line up.
//
// If the numbers are ever wanted on screen, they must be the DOC's numbers
// (P1..P4), never the stored ones.

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

export const PRIORITY_LABEL = {
  P0: 'Critical',
  P1: 'High',
  P2: 'Standard',
  P3: 'Low',
};

// The doc's own wording, so the person choosing sees the test they are meant
// to apply rather than guessing what "high" means today.
export const PRIORITY_MEANING = {
  P0: 'Trading stopped or payments failing. The site cannot take money.',
  P1: 'Trading affected but possible. A significant function is down, or a workaround is in place.',
  P2: 'An issue or question that is not stopping service.',
  P3: 'Requests, changes, reporting, training and general advice.',
};

// First response / update frequency / target resolution, quoted from the doc.
export const PRIORITY_SLA = {
  P0: { respond: 'Immediate', update: 'Every 30 minutes', resolve: 'Same day, work continues until resolved' },
  P1: { respond: 'Within 1 hour', update: 'Every 2 hours', resolve: 'Within 1 working day' },
  P2: { respond: 'Within 4 working hours', update: 'Daily', resolve: 'Within 3 working days' },
  P3: { respond: 'Within 1 working day', update: 'As agreed', resolve: 'By agreed date' },
};

export const priorityLabel = (p) => PRIORITY_LABEL[p] || p || '—';

/** [value, label] pairs for the shared select helpers. */
export const PRIORITY_OPTIONS = PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]]);

/** Same, with an "all" row for filter dropdowns. */
export const PRIORITY_FILTER_OPTIONS = [['all', 'All priorities'], ...PRIORITY_OPTIONS];
