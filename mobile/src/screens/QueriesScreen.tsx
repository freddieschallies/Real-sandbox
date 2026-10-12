// The technician's queries: questions from the office or other technicians, and his own.
import React, { useState } from 'react';
import { useNav } from '../nav.tsx';
import { useStore } from '../state.tsx';
import { Screen } from '../ui.tsx';
import { NewQuery, QueryList, QueryThread, useQueries } from '../queries/Queries.tsx';

export function QueriesScreen() {
  const nav = useNav();
  const s = useStore();
  const q = useQueries();
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'thread'; id: string } | { kind: 'new' }>({ kind: 'list' });
  const jobs = (s.cache.today?.jobs ?? []).map(j => ({ id: j.id, label: `#${j.job_number} ${j.store}` }));
  const back = view.kind === 'list' ? nav.back : () => setView({ kind: 'list' });
  return (
    <Screen title="Queries" sub={q.unread ? `${q.unread} new` : undefined} onBack={back}>
      {view.kind === 'list' ? <QueryList q={q} open={id => setView({ kind: 'thread', id })} ask={() => setView({ kind: 'new' })} /> : null}
      {view.kind === 'thread' ? <QueryThread q={q} id={view.id} /> : null}
      {view.kind === 'new' ? <NewQuery q={q} jobs={jobs} done={() => setView({ kind: 'list' })} /> : null}
    </Screen>
  );
}
