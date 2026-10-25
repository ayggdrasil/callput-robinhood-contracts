import nvidiaLogo from '../assets/img/symbol/nvda-on.svg';
import teslaLogo from '../assets/img/symbol/tsla-on.svg';
import appleLogo from '../assets/img/symbol/aapl-on.svg';

const logos = {NVDA: nvidiaLogo, TSLA: teslaLogo, AAPL: appleLogo} as const;

export default function StructureStockLogo({symbol, className}: {symbol: keyof typeof logos; className: string}) {
  return <img className={`${className} st-stock-logo`} src={logos[symbol]} alt="" aria-hidden="true"/>;
}
