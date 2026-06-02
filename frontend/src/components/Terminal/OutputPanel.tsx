import { TerminalSquare, Activity } from 'lucide-react';

interface OutputPanelProps {
  output: string;
  isExecuting: boolean;
}

export default function OutputPanel({ output, isExecuting }: OutputPanelProps) {
  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] text-zinc-300">
      {isExecuting && (
        <div className="px-4 py-2.5 bg-indigo-500/5 border-b border-indigo-500/10 text-xs font-medium text-indigo-400 flex items-center gap-2.5">
          <Activity size={14} className="animate-pulse" />
          <span>Executing code locally...</span>
        </div>
      )}
      <div className="flex-1 p-5 overflow-y-auto font-mono text-[13px] whitespace-pre-wrap leading-relaxed tracking-wide">
        {output ? (
          <span className={output.includes('[Error]') || output.includes('Error:') ? 'text-red-400' : 'text-zinc-300'}>
            {output}
          </span>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500/60 mt-10 gap-3">
            <TerminalSquare size={36} className="opacity-80" strokeWidth={1.5} />
            <p className="italic font-sans text-sm">Output will appear here after execution</p>
          </div>
        )}
      </div>
    </div>
  );
}