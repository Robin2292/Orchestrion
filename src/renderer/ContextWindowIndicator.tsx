import { useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import type { ContextWindowUsage } from "../shared/contracts";
import { presentContextWindowUsage } from "../shared/context-window";

const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface ContextWindowIndicatorProps {
  usage: ContextWindowUsage | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContextWindowIndicator({ usage, open, onOpenChange }: ContextWindowIndicatorProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const presentation = presentContextWindowUsage(usage);
  const summary = presentation.available
    ? `${presentation.usedLabel} of ${presentation.totalLabel}, ${presentation.percentageLabel}`
    : "telemetry unavailable";

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onOpenChange, open]);

  const dashOffset = RING_CIRCUMFERENCE * (1 - presentation.visualPercentage / 100);
  return <div className="context-window-anchor" ref={anchorRef}>
    <button
      className={`context-window-trigger tone-${presentation.tone}`}
      type="button"
      aria-label={`Context window: ${summary}`}
      aria-expanded={open}
      aria-controls="context-window-popover"
      onClick={() => onOpenChange(!open)}
      title={`Context window: ${summary}`}
    >
      <svg className="context-window-ring" viewBox="0 0 20 20" aria-hidden="true">
        <circle className="context-window-ring-track" cx="10" cy="10" r={RING_RADIUS} />
        <circle
          className="context-window-ring-value"
          cx="10"
          cy="10"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
        />
      </svg>
    </button>
    {open && <div id="context-window-popover" className={`context-window-popover tone-${presentation.tone}`} role="region" aria-label="Context window usage">
      <div className="context-window-summary-row">
        <span className="context-window-label">Context window</span>
        <span className="context-window-value">
          {presentation.available
            ? `${presentation.usedLabel} / ${presentation.totalLabel} (${presentation.percentageLabel})`
            : "Unavailable"}
        </span>
        <button className="context-window-details" type="button" disabled aria-label="Context window breakdown coming soon" title="Context window breakdown coming soon">
          <span>Details soon</span><ChevronRight size={13} aria-hidden="true" />
        </button>
      </div>
      <div
        className="context-window-progress"
        role="progressbar"
        aria-label="Context window used"
        aria-valuemin={0}
        aria-valuemax={presentation.available ? 100 : undefined}
        aria-valuenow={presentation.available ? Math.round(presentation.visualPercentage) : undefined}
        aria-valuetext={presentation.available ? summary : "Waiting for runtime telemetry"}
      >
        {presentation.available && <span style={{ width: `${presentation.visualPercentage}%` }} />}
      </div>
      {!presentation.available && <p className="context-window-note">Waiting for context telemetry from the local Codex runtime.</p>}
      {presentation.tone === "overflow" && <p className="context-window-note warning">Reported usage exceeds this model's context window.</p>}
    </div>}
  </div>;
}
