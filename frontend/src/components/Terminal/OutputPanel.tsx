import { TerminalSquare, Loader2 } from 'lucide-react';

interface ExecutionMetrics {
  durationMs: number;
  exitCode: number;
  oomKilled: boolean;
  cpuUsagePercent?: number;
  memoryUsageBytes?: number;
}

interface OutputPanelProps {
  output: string;
  isExecuting: boolean;
  metrics?: ExecutionMetrics | null;
}

// Max characters to render in the DOM. Rendering megabytes of text creates
// thousands of DOM nodes, causing browser lag and burying warning messages.
// If the output exceeds this, we show the LAST N chars (most recent output)
// and a notice at the top telling the user how much was clipped.
const MAX_RENDER_CHARS = 20_000; // ~200 lines of 100 chars each

export default function OutputPanel({ output, isExecuting, metrics }: OutputPanelProps) {
  // Determine what to actually render.
  let displayOutput = output;
  let wasTrimmed = false;
  let trimmedBytes = 0;

  if (output.length > MAX_RENDER_CHARS) {
    wasTrimmed = true;
    trimmedBytes = output.length - MAX_RENDER_CHARS;
    // Keep the TAIL of the output — that's where the important messages are
    // (warnings, errors, final results). The beginning is usually just bulk output.
    displayOutput = output.slice(-MAX_RENDER_CHARS);
  }

  const isError = output.includes('[Error]') || output.includes('Error:') || output.includes('Traceback') || (metrics && metrics.exitCode !== 0);
  const isWarning = output.includes('[Warning]');

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#08070d] text-zinc-300">
      {isExecuting && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-[#08070d]/60 backdrop-blur-[2px] transition-all">
          <Loader2 size={36} className="animate-spin text-violet-400" />
          <span className="animate-pulse font-sans text-sm font-medium tracking-wide text-violet-300">Executing code in sandbox...</span>
        </div>
      )}

      {/* Execution Metrics Header Bar */}
      {metrics && !isExecuting && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/[0.04] bg-white/[0.01] px-5 py-2 text-[11px] font-sans text-zinc-400">
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${metrics.exitCode === 0 ? 'bg-emerald-500' : 'bg-red-500'}`} />
            <span className={metrics.exitCode === 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
              {metrics.exitCode === 0 ? 'Success' : 'Failed'}
            </span>
          </div>
          <div className="h-3 w-px bg-white/[0.08]" />
          <div>
            Duration: <span className="font-mono text-zinc-200">{metrics.durationMs.toFixed(0)} ms</span>
          </div>
          <div className="h-3 w-px bg-white/[0.08]" />
          <div>
            Exit Code: <span className={`font-mono ${metrics.exitCode === 0 ? 'text-zinc-200' : 'text-red-400'}`}>{metrics.exitCode}</span>
          </div>
          {metrics.cpuUsagePercent !== undefined && metrics.cpuUsagePercent !== null && (
            <>
              <div className="h-3 w-px bg-white/[0.08]" />
              <div>
                CPU: <span className="font-mono text-zinc-200">{metrics.cpuUsagePercent.toFixed(1)}%</span>
              </div>
            </>
          )}
          {metrics.memoryUsageBytes !== undefined && metrics.memoryUsageBytes !== null && (
            <>
              <div className="h-3 w-px bg-white/[0.08]" />
              <div>
                RAM: <span className="font-mono text-zinc-200">
                  {metrics.memoryUsageBytes >= 1024 * 1024
                    ? `${(metrics.memoryUsageBytes / 1024 / 1024).toFixed(1)} MB`
                    : `${(metrics.memoryUsageBytes / 1024).toFixed(0)} KB`}
                </span>
              </div>
            </>
          )}
          {metrics.oomKilled && (
            <>
              <div className="h-3 w-px bg-white/[0.08]" />
              <div className="rounded bg-red-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-400 border border-red-500/20">
                OOM Killed (100MB Cap)
              </div>
            </>
          )}
        </div>
      )}

      <div className={`flex-1 overflow-y-auto p-5 font-mono text-[13px] leading-relaxed tracking-wide whitespace-pre-wrap transition-all duration-300 ${isExecuting ? 'opacity-30' : 'opacity-100'}`}>
        {output ? (
          <>
            {/* Trim notice — shown at the TOP so it's immediately visible */}
            {wasTrimmed && (
              <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 font-sans text-[12px] text-amber-400">
                ⚠ Output too large to fully display ({(trimmedBytes / 1024).toFixed(1)} KB hidden).
                Showing the last {(MAX_RENDER_CHARS / 1000).toFixed(0)} KB. Scroll down for warnings/errors.
              </div>
            )}
            <span
              className={
                isError
                  ? 'text-red-400'
                  : isWarning
                  ? 'text-amber-300'
                  : 'text-zinc-300'
              }
            >
              {displayOutput}
            </span>
          </>
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