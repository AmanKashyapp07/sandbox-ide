import { TerminalSquare, Loader2 } from 'lucide-react';

interface OutputPanelProps {
  output: string;
  isExecuting: boolean;
}

export default function OutputPanel({ output, isExecuting }: OutputPanelProps) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#07080a] text-zinc-300">
      {isExecuting && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-[#07080a]/60 backdrop-blur-[2px] transition-all">
          <Loader2 size={36} className="animate-spin text-cyan-400" />
          <span className="animate-pulse font-sans text-sm font-medium tracking-wide text-cyan-300">Executing code in sandbox...</span>
        </div>
      )}
      <div className={`flex-1 overflow-y-auto p-5 font-mono text-[13px] leading-relaxed tracking-wide whitespace-pre-wrap transition-all duration-300 ${isExecuting ? 'opacity-30' : 'opacity-100'}`}>
        {output ? (
          <span className={output.includes('[Error]') || output.includes('Error:') ? 'text-red-400' : 'text-zinc-300'}>
            {output}
          </span>
        ) : (
          <div className="mt-10 flex h-full flex-col items-center justify-center gap-3 text-zinc-500/60">
            <TerminalSquare size={36} className="opacity-80" strokeWidth={1.5} />
            <p className="font-sans text-sm italic">Output will appear here after execution</p>
          </div>
        )}
      </div>
    </div>
  );
}