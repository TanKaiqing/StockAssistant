import { useEffect, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import './InstrumentFields.css';

export type InstrumentForm = {code: string; name: string; kind: 'stock' | 'etf'};
type Lookup = {query: string; candidates: InstrumentForm[]; loading: boolean; error: string};

export function InstrumentFields({form, onChange, busy, open}: {
  form: InstrumentForm; onChange: (form: InstrumentForm) => void; busy: boolean; open: boolean;
}) {
  const [lookup, setLookup] = useState<Lookup>({query: '', candidates: [], loading: false, error: ''});
  const [chosen, setChosen] = useState(false);
  const [source, setSource] = useState<'code' | 'name'>('code');
  const [composing, setComposing] = useState(false);
  const [retry, setRetry] = useState(0);
  const query = (source === 'code' ? form.code : form.name).trim();
  useEffect(() => {
    const valid = source === 'code' ? /^[0-9]{3,6}$/.test(query) : query.length >= 2;
    if (!open || !valid || chosen || composing) {
      setLookup({query: '', candidates: [], loading: false, error: ''}); return;
    }
    let active = true;
    const controller = new AbortController();
    setLookup({query, candidates: [], loading: true, error: ''});
    const timer = window.setTimeout(() => {
      void api<{candidates: InstrumentForm[]}>(`/instruments/search?q=${encodeURIComponent(query)}`, {signal: controller.signal})
        .then(result => {if (active) setLookup({query, candidates: result.candidates ?? [], loading: false, error: ''});})
        .catch(error => {if (active) setLookup({query, candidates: [], loading: false, error: error.message});});
    }, 300);
    return () => {active = false; controller.abort(); window.clearTimeout(timer);};
  }, [open, query, source, chosen, composing, retry]);
  const current = !!query && lookup.query === query;
  function suggestions(field: 'code' | 'name') {
    if (source !== field) return null;
    return <>
      <div id={`instrument-${field}-hint`} className="instrument-search-hint" role="status">
        {chosen ? <><Check size={13}/>已填入代码、名称与类型，可继续修改</> : current && lookup.loading ? <><LoaderCircle size={13} className="spin"/>正在查询候选…</> : current && lookup.error ? <><span>{lookup.error}</span><button className="text-button" type="button" disabled={busy} onClick={() => setRetry(value => value + 1)}>重试</button></> : current && !lookup.candidates.length ? '未找到匹配标的，可手动填写' : field === 'code' ? '输入至少 3 位代码，选择候选后自动填写' : '输入至少 2 个字的名称或拼音，选择候选后自动填写'}
      </div>
      {current && !chosen && lookup.candidates.length > 0 && <div className="instrument-candidates" role="group" aria-label="证券候选名称">{lookup.candidates.map(candidate => <button type="button" key={candidate.code} disabled={busy} onClick={() => {setChosen(true); onChange(candidate);}}><span className="candidate-code">{candidate.code}</span><strong>{candidate.name}</strong><span className="kind-badge">{candidate.kind === 'etf' ? 'ETF' : '股票'}</span></button>)}</div>}
    </>;
  }
  return <>
    <div className="field"><label htmlFor="instrument-code">证券代码</label><input id="instrument-code" placeholder="例如 510300" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="off" disabled={busy} value={form.code} aria-describedby={source === 'code' ? 'instrument-code-hint' : undefined}
      onFocus={() => setSource('code')} onChange={e => {setSource('code'); setChosen(false); onChange({...form, code: e.target.value.replace(/\D/g, ''), name: ''});}}/>
      {suggestions('code')}
    </div>
    <div className="field"><label htmlFor="instrument-name">名称</label><input id="instrument-name" placeholder="例如 沪深300 / hs300" maxLength={40} required autoComplete="off" disabled={busy} value={form.name} aria-describedby={source === 'name' ? 'instrument-name-hint' : undefined}
      onFocus={() => setSource('name')} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onChange={e => {setSource('name'); setChosen(false); onChange({...form, name: e.target.value});}}/>{suggestions('name')}</div>
    <div className="field"><label htmlFor="instrument-kind">标的类型</label><select id="instrument-kind" disabled={busy} value={form.kind} onChange={e => onChange({...form, kind: e.target.value as 'stock' | 'etf'})}><option value="stock">A 股股票</option><option value="etf">场内 ETF</option></select></div>
  </>;
}
