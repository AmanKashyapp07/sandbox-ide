import { useEffect, useState, useMemo } from 'react';
import { X, Activity, Cpu, Database, RefreshCw, Clock, Terminal, User } from 'lucide-react';

// =============================================================================
// PERFORMANCE MODAL DIAGNOSTICS COMPONENT
// =============================================================================
//
// INTERVIEW PREP & FRONTEND ARCHITECTURE DESIGN:
//
// 1. LIGHTWEIGHT NATIVE SVG CHARTING VS HEAVY CHART LIBRARIES:
//    - Instead of importing bulky libraries (Recharts, Chart.js) which add hundreds of KB
//      to the client bundle, we build custom SVG line charts.
//      This guarantees 100% style compatibility, sub-millisecond render times, and
//      eliminates complex hydration mismatches during Server-Side Rendering (SSR).
//
// 2. MEMOIZATION FOR PATH RENDERING AND REFLECTION (useMemo):
//    - We partition history processing, unique file extraction, and coordinate-to-path
//      mapping using React `useMemo`. Hovering over a graph node triggers state changes
//      (e.g., `hoveredCpuIndex`). Without memoization, hovering would cause a full reflow
//      and recalculate all SVG path coordinates, introducing rendering lag.
//
// 3. EVENT STREAM BUBBLING AND POINTER-EVENTS FLICKER MITIGATION:
//    - To prevent flickering tooltips, we set `pointer-events: none` on the tooltip
//      overlay element. This ensures hover triggers target the underlying SVG dots,
//      avoiding cursor hit-box hijacking when the tooltip renders directly beneath the mouse.
//
// 4. DATA PRESENTATION VS DATA PERSISTENCE:
//    - Raw database statistics (bytes, raw timestamps) are converted in real-time
//      into user-friendly indicators (e.g., "7.5 MB", "12m ago").
//
interface ExecutionHistoryRecord {
  id: string;
  user_id: string | null;
  username: string | null;
  language: string;
  status: 'success' | 'failed' | 'timeout' | 'error';
  duration_ms: number;
  memory_usage_bytes: number;
  cpu_usage_percent: number;
  file_name: string | null;
  executed_at: string;
}

interface PerformanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
}

export default function PerformanceModal({ isOpen, onClose, workspaceId }: PerformanceModalProps) {
  const [history, setHistory] = useState<ExecutionHistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string>('all');
  
  // Interactive states
  const [hoveredCpuIndex, setHoveredCpuIndex] = useState<number | null>(null);
  const [hoveredMemIndex, setHoveredMemIndex] = useState<number | null>(null);

  const fetchHistory = async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`http://localhost:4000/api/workspace/${workspaceId}/execution-history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setHistory(data);
      }
    } catch (err) {
      console.error('Failed to fetch execution history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchHistory();
    }
  }, [isOpen, workspaceId]);

  // --- Chart Dimensions & Helpers ---
  const width = 500;
  const height = 140;
  const padding = 25;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const mb = bytes / 1024 / 1024;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  const formatTimeAgo = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);

    if (diffSec < 60) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // Memoize unique file names for filter options
  const uniqueFiles = useMemo(() => {
    const files = new Set<string>();
    history.forEach((h) => {
      if (h.file_name) files.add(h.file_name);
    });
    return Array.from(files);
  }, [history]);

  // Filter history based on selectedFile
  const filteredHistory = useMemo(() => {
    if (selectedFile === 'all') return history;
    return history.filter((h) => h.file_name === selectedFile);
  }, [history, selectedFile]);

  // --- Memoized Chart Calculations ---
  // This prevents the entire SVG from recalculating its paths every time you hover over a point.
  const chartData = useMemo(() => {
    const plotData = [...filteredHistory].reverse();
    if (plotData.length === 0) return null;

    const stepX = plotData.length > 1 ? chartWidth / (plotData.length - 1) : chartWidth;
    
    // CPU Calculations
    const maxCpu = Math.max(10, ...plotData.map((d) => Number(d.cpu_usage_percent)));
    const cpuPoints = plotData.map((d, i) => ({
      x: padding + i * stepX,
      y: padding + chartHeight - (Number(d.cpu_usage_percent) / maxCpu) * chartHeight,
      val: Number(d.cpu_usage_percent)
    }));
    const cpuPathD = cpuPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const cpuAreaD = `${cpuPathD} L ${cpuPoints[cpuPoints.length - 1].x} ${height - padding} L ${cpuPoints[0].x} ${height - padding} Z`;

    // Memory Calculations
    const maxMem = Math.max(1024 * 1024, ...plotData.map((d) => Number(d.memory_usage_bytes)));
    const memPoints = plotData.map((d, i) => ({
      x: padding + i * stepX,
      y: padding + chartHeight - (Number(d.memory_usage_bytes) / maxMem) * chartHeight,
      val: Number(d.memory_usage_bytes)
    }));
    const memPathD = memPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const memAreaD = `${memPathD} L ${memPoints[memPoints.length - 1].x} ${height - padding} L ${memPoints[0].x} ${height - padding} Z`;

    return { plotData, stepX, cpuPoints, cpuPathD, cpuAreaD, memPoints, memPathD, memAreaD };
  }, [history, chartWidth, chartHeight]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-[#000]/60 backdrop-blur-md">
      <div className="relative flex flex-col w-full max-w-4xl h-[85vh] rounded-[2rem] border border-white/10 bg-[#0c0b12]/95 text-zinc-200 shadow-[0_24px_100px_rgba(0,0,0,0.8)] overflow-hidden">
        
        <div className="absolute top-0 left-1/4 right-1/4 h-[2px] bg-gradient-to-r from-transparent via-violet-500/50 to-transparent blur-sm pointer-events-none" />

        <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.01] px-6 py-5 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-violet-400/15 bg-violet-400/10">
              <Activity className="text-violet-300" size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Performance Diagnostics</h2>
              <p className="text-xs text-zinc-500">Live profiling metrics and execution history trends</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchHistory} disabled={loading} className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-40">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-8 space-y-8 min-h-0">
          {history.length === 0 || !chartData ? (
            <div className="flex flex-col items-center justify-center h-60 text-center gap-3 text-zinc-500">
              <Terminal size={40} className="opacity-30 text-violet-400" />
              <p className="text-sm font-medium">No execution history found in this session.</p>
              <p className="text-xs max-w-sm text-zinc-600">Run code from the IDE to capture performance analytics, memory footprints, and CPU usage spikes.</p>
            </div>
          ) : (
            <>
              {/* Charts Grid */}
              <div className="grid gap-6 md:grid-cols-2 select-none">
                
                {/* CPU Trend Line Chart */}
                <div className="relative rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 shadow-[0_8px_32px_rgba(0,0,0,0.25)] flex flex-col">
                  <div className="flex items-center gap-2 mb-3">
                    <Cpu size={16} className="text-violet-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Peak CPU % Trend</span>
                  </div>
                  
                  <div className="relative flex-1 flex items-center justify-center min-h-[140px]" onMouseLeave={() => setHoveredCpuIndex(null)}>
                    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
                      <defs>
                        <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.25" />
                          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.00" />
                        </linearGradient>
                      </defs>
                      
                      <line x1={padding} y1={padding} x2={width-padding} y2={padding} stroke="rgba(255,255,255,0.03)" strokeDasharray="3 3" />
                      <line x1={padding} y1={height - padding} x2={width-padding} y2={height - padding} stroke="rgba(255,255,255,0.08)" />
                      
                      <path d={chartData.cpuAreaD} fill="url(#cpuGrad)" className="pointer-events-none" />
                      <path d={chartData.cpuPathD} fill="none" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none" />

                      {/* Data Points and Interaction Layer */}
                      {chartData.cpuPoints.map((p, idx) => {
                        const isHovered = hoveredCpuIndex === idx;
                        return (
                          <g key={`cpu-${idx}`}>
                            {/* Visual Circle - Removes CSS hover to prevent layout jitter */}
                            <circle
                              cx={p.x}
                              cy={p.y}
                              r={isHovered ? 6 : 4}
                              fill="#8b5cf6"
                              stroke="#13111c"
                              strokeWidth={isHovered ? 3 : 2}
                              className="transition-all duration-200 ease-out pointer-events-none"
                            />
                            
                            {/* Invisible Hitbox for smooth hover/click interaction */}
                            <rect
                              x={p.x - Math.max(chartData.stepX / 2, 10)}
                              y={0}
                              width={Math.max(chartData.stepX, 20)}
                              height={height}
                              fill="transparent"
                              className="cursor-crosshair"
                              onMouseEnter={() => setHoveredCpuIndex(idx)}
                              onClick={() => setHoveredCpuIndex(idx)}
                            />

                            {/* Tooltip */}
                            {isHovered && (
                              <g className="pointer-events-none transition-opacity duration-200">
                                <rect x={Math.max(0, p.x - 30)} y={p.y - 32} width="60" height="22" rx="6" fill="#161320" stroke="rgba(139, 92, 246, 0.4)" strokeWidth="1" />
                                <text x={p.x} y={p.y - 17} textAnchor="middle" className="fill-violet-300 font-mono text-[10px] font-bold">
                                  {p.val.toFixed(1)}%
                                </text>
                              </g>
                            )}
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                  <div className="flex items-center justify-between text-[9px] text-zinc-600 mt-2 font-mono px-2">
                    <span>Oldest Run</span>
                    <span>→ Latest Run →</span>
                    <span>Newest Run</span>
                  </div>
                </div>

                {/* RAM Trend Line Chart */}
                <div className="relative rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 shadow-[0_8px_32px_rgba(0,0,0,0.25)] flex flex-col">
                  <div className="flex items-center gap-2 mb-3">
                    <Database size={16} className="text-emerald-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Peak Memory footprint</span>
                  </div>

                  <div className="relative flex-1 flex items-center justify-center min-h-[140px]" onMouseLeave={() => setHoveredMemIndex(null)}>
                    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
                      <defs>
                        <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
                          <stop offset="100%" stopColor="#10b981" stopOpacity="0.00" />
                        </linearGradient>
                      </defs>
                      
                      <line x1={padding} y1={padding} x2={width-padding} y2={padding} stroke="rgba(255,255,255,0.03)" strokeDasharray="3 3" />
                      <line x1={padding} y1={height - padding} x2={width-padding} y2={height - padding} stroke="rgba(255,255,255,0.08)" />

                      <path d={chartData.memAreaD} fill="url(#memGrad)" className="pointer-events-none" />
                      <path d={chartData.memPathD} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none" />

                      {/* Data Points and Interaction Layer */}
                      {chartData.memPoints.map((p, idx) => {
                        const isHovered = hoveredMemIndex === idx;
                        return (
                          <g key={`mem-${idx}`}>
                            {/* Visual Circle */}
                            <circle
                              cx={p.x}
                              cy={p.y}
                              r={isHovered ? 6 : 4}
                              fill="#10b981"
                              stroke="#13111c"
                              strokeWidth={isHovered ? 3 : 2}
                              className="transition-all duration-200 ease-out pointer-events-none"
                            />

                            {/* Invisible Hitbox */}
                            <rect
                              x={p.x - Math.max(chartData.stepX / 2, 10)}
                              y={0}
                              width={Math.max(chartData.stepX, 20)}
                              height={height}
                              fill="transparent"
                              className="cursor-crosshair"
                              onMouseEnter={() => setHoveredMemIndex(idx)}
                              onClick={() => setHoveredMemIndex(idx)}
                            />

                            {/* Tooltip */}
                            {isHovered && (
                              <g className="pointer-events-none transition-opacity duration-200">
                                <rect x={Math.max(0, p.x - 35)} y={p.y - 32} width="70" height="22" rx="6" fill="#161320" stroke="rgba(16, 185, 129, 0.4)" strokeWidth="1" />
                                <text x={p.x} y={p.y - 17} textAnchor="middle" className="fill-emerald-300 font-mono text-[10px] font-bold">
                                  {formatBytes(p.val)}
                                </text>
                              </g>
                            )}
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                  <div className="flex items-center justify-between text-[9px] text-zinc-600 mt-2 font-mono px-2">
                    <span>Oldest Run</span>
                    <span>→ Latest Run →</span>
                    <span>Newest Run</span>
                  </div>
                </div>

              </div>

              {/* Table list of executions */}
              <div className="flex flex-col">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Collaborative Execution Logs</span>
                  {uniqueFiles.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-zinc-500 font-medium font-sans">Filter by file:</span>
                      <select
                        value={selectedFile}
                        onChange={(e) => {
                          setSelectedFile(e.target.value);
                          setHoveredCpuIndex(null);
                          setHoveredMemIndex(null);
                        }}
                        className="bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] rounded-xl text-xs text-zinc-300 px-3 py-1.5 focus:outline-none focus:border-violet-500/50 cursor-pointer transition-all font-sans"
                      >
                        <option value="all" className="bg-[#12111a]">All Files</option>
                        {uniqueFiles.map(file => (
                          <option key={file} value={file} className="bg-[#12111a]">{file}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.01]">
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.02] font-semibold text-zinc-400 select-none">
                          <th className="px-5 py-3">Timestamp</th>
                          <th className="px-5 py-3">Executor</th>
                          <th className="px-5 py-3">File</th>
                          <th className="px-5 py-3">Status</th>
                          <th className="px-5 py-3">Language</th>
                          <th className="px-5 py-3 text-right">Duration</th>
                          <th className="px-5 py-3 text-right">Peak CPU</th>
                          <th className="px-5 py-3 text-right">Peak Memory</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {chartData.plotData.map((record) => (
                          <tr key={record.id} className="hover:bg-white/[0.02] transition-colors">
                            <td className="whitespace-nowrap px-5 py-3 text-zinc-400 flex items-center gap-1.5">
                              <Clock size={12} className="opacity-60" />
                              {formatTimeAgo(record.executed_at)}
                            </td>
                            <td className="whitespace-nowrap px-5 py-3 font-medium text-zinc-300">
                              <span className="flex items-center gap-1">
                                <User size={12} className="opacity-40 text-violet-400" />
                                {record.username || 'Anonymous'}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-5 py-3 font-medium text-zinc-300">
                              <span className="font-mono text-zinc-300 bg-white/[0.04] px-1.5 py-0.5 rounded border border-white/[0.04]">
                                {record.file_name || 'untitled'}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-5 py-3">
                              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                record.status === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' :
                                record.status === 'failed' ? 'border-red-500/20 bg-red-500/10 text-red-400' :
                                record.status === 'timeout' ? 'border-orange-500/20 bg-orange-500/10 text-orange-400' :
                                'border-amber-500/20 bg-amber-500/10 text-amber-400'
                              }`}>
                                <span className={`h-1 w-1 rounded-full ${
                                  record.status === 'success' ? 'bg-emerald-400' :
                                  record.status === 'failed' ? 'bg-red-400' :
                                  record.status === 'timeout' ? 'bg-orange-400' :
                                  'bg-amber-400'
                                }`} />
                                {record.status}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-5 py-3 font-mono text-[11px] text-zinc-400">
                              {record.language}
                            </td>
                            <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-zinc-300">
                              {record.duration_ms} ms
                            </td>
                            <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-zinc-300">
                              {record.cpu_usage_percent !== null ? `${Number(record.cpu_usage_percent).toFixed(1)}%` : '0.0%'}
                            </td>
                            <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-zinc-300">
                              {formatBytes(record.memory_usage_bytes)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}