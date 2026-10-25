import {FUNDING_STEPS, type FundingJournal} from '../structure/workflow';

type ProgressStatus='upcoming'|'ready'|'sending'|'pending'|'confirmed'|'rejected'|'reverted'|'unknown'|'failed';
type ProgressStep={id:string;label:string;status:ProgressStatus;hash?:string};

/** Presentation of the existing journal, never a second execution state machine. */
export function strategyProgress(journal:FundingJournal|null,walletMode:boolean):ProgressStep[] {
  const order=journal?.order;
  const submitted=Boolean(order && (order.status==='filled'
    || walletMode && ['pending','failed'].includes(order.status) && order.hash && order.requestId));
  const authorized=Boolean(order && (order.status==='filled' || !order.notSubmitted && (order.hash || order.requestId)));
  const rows:ProgressStep[]=FUNDING_STEPS.map(id=>({id,label:{approve:'Stock approval',supply:'Supply stock',borrow:'Borrow USDG'}[id],
    status:!journal || journal.steps[id].status==='idle' ? 'upcoming' : journal.steps[id].status,hash:journal?.steps[id].hash}));
  if(walletMode) rows.push({id:'walletApproval',label:'USDG approval',hash:journal?.walletApproval?.hash,
    status:journal?.walletApproval?.status==='idle' ? 'upcoming' : journal?.walletApproval?.status ?? (authorized ? 'confirmed' : 'upcoming')});
  rows.push(
    {id:'order',label:'Submit order',status:order?.status==='filled' || submitted ? 'confirmed' : order?.status ?? 'upcoming',hash:order?.hash},
    {id:'fill',label:'Automatic fill',status:order?.status==='filled' ? 'confirmed' : submitted ? order?.status==='failed' ? 'failed' : 'pending' : 'upcoming'},
  );
  const next=rows.findIndex(row=>row.status!=='confirmed');
  if(next>=0 && rows[next].status==='upcoming') rows[next].status='ready';
  return rows;
}

const stateLabel=(step:ProgressStep)=>({
  upcoming:'Waiting',ready:step.id==='fill' ? 'Automatic' : 'Next',sending:'Confirm in wallet',
  pending:step.id==='fill' ? 'Awaiting fill' : 'Confirming on-chain',confirmed:step.id==='fill' ? 'Filled' : 'Complete',
  rejected:'Signature declined',reverted:'Transaction reverted',unknown:'Verify original transaction',failed:'Failed',
})[step.status];

const hasDescriptiveStatus=(step:ProgressStep)=>!['upcoming','ready','confirmed'].includes(step.status);
const needsStatus=(step:ProgressStep)=>['rejected','reverted','unknown','failed'].includes(step.status);

export default function StructureProgress({journal,walletMode,reviewRequired=false,error,transactionUrl}: {
  journal:FundingJournal|null;walletMode:boolean;reviewRequired?:boolean;error?:string;transactionUrl?:(hash:string)=>string;
}) {
  const steps=strategyProgress(journal,walletMode),next=steps.findIndex(step=>step.status!=='confirmed');
  const current=steps[next],complete=steps.filter(step=>step.status==='confirmed').length;
  const needsAttention=current && !['ready','upcoming'].includes(current.status);
  const headline=reviewRequired && !needsAttention ? 'Review order quote' : !journal ? 'Your next steps'
    : current ? hasDescriptiveStatus(current) ? `${current.label} · ${stateLabel(current)}` : current.label : 'Strategy opened';
  return <section className="st-transaction-progress" aria-label="Strategy setup progress">
    <div className="st-progress-heading"><p role="status" aria-live="polite" aria-atomic="true">{headline}</p><span>{complete} / {steps.length}</span></div>
    <ol className="st-progress-grid">{steps.map((step,index)=><li key={step.id} data-state={step.status} aria-current={next===index ? 'step' : undefined}>
      <span className="st-progress-marker" aria-hidden="true">{step.status==='confirmed' ? '✓' : index+1}</span>
      <div aria-label={`${step.label}: ${stateLabel(step)}`}><strong>{step.label}</strong>{(next===index && hasDescriptiveStatus(step) || needsStatus(step)) && <small>{stateLabel(step)}</small>}</div>
      {step.hash && transactionUrl && <a href={transactionUrl(step.hash)} target="_blank" rel="noreferrer" aria-label={`View ${step.label} transaction`}>↗</a>}
    </li>)}</ol>
    {!journal && <p className="st-progress-note">{walletMode ? 'Up to 5 wallet confirmations.' : '3 lending steps → submit order.'}</p>}
    {error && <p role="alert" className="st-progress-error">{error}</p>}
  </section>;
}
