import { fmtTs } from "../lib/format";
import type { Segment } from "../lib/ipc";

type Props = {
  segments: Segment[];
  showDiff?: boolean;
  emptyHint?: string;
};

export default function SegmentList({ segments, showDiff = false, emptyHint }: Props) {
  if (!segments.length) {
    return (
      <div className="text-sm text-text-mute py-12 text-center">
        {emptyHint ?? "(暂无内容)"}
      </div>
    );
  }
  return (
    <ul className="space-y-1.5 font-mono text-sm leading-relaxed">
      {segments.map((s, i) => {
        const changed = showDiff && s.original_text && s.original_text !== s.text;
        return (
          <li key={i} className="flex gap-3">
            <span className="text-xs text-text-mute pt-0.5 whitespace-nowrap shrink-0">
              {fmtTs(s.start)}
            </span>
            <div className="flex-1 min-w-0">
              {changed && (
                <div className="text-xs text-red-400/70 line-through truncate">
                  {s.original_text}
                </div>
              )}
              <div className={changed ? "text-emerald-300" : "text-text"}>
                {s.text}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
