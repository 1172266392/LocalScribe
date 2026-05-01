import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";

import { FileAdd } from "./Icons";

const ACCEPTED_EXTS = ["m4a", "mp3", "wav", "ogg", "flac", "aac", "opus", "mp4", "mov", "mkv", "webm"];

type Props = {
  onPick: (paths: string[]) => void;
  disabled?: boolean;
};

export default function DropZone({ onPick, disabled }: Props) {
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    (async () => {
      const u = await listen<{ paths: string[]; type: string }>("tauri://drag-drop", (e) => {
        if (disabled) return;
        const paths = (e.payload?.paths ?? []).filter((p) => {
          const ext = p.split(".").pop()?.toLowerCase() ?? "";
          return ACCEPTED_EXTS.includes(ext);
        });
        if (paths.length) onPick(paths);
        setHovering(false);
      });
      const enter = await listen("tauri://drag-enter", () => setHovering(true));
      const leave = await listen("tauri://drag-leave", () => setHovering(false));
      if (!active) {
        u(); enter(); leave();
      } else {
        unlisten = () => { u(); enter(); leave(); };
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [onPick, disabled]);

  async function pickFile() {
    if (disabled) return;
    const selected = await open({
      multiple: true,
      filters: [{ name: "Audio / Video", extensions: ACCEPTED_EXTS }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    onPick(paths);
  }

  return (
    <button
      onClick={pickFile}
      disabled={disabled}
      className={clsx(
        "w-full py-4 px-3 rounded-sm border border-dashed transition-colors",
        "flex flex-col items-center gap-1.5 text-ui-sm",
        hovering
          ? "border-accent bg-accent/10 text-accent"
          : "border-border bg-transparent hover:border-accent/60 hover:bg-hover text-fg-dim",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <FileAdd size={20} className={hovering ? "text-accent" : "text-fg-mute"} />
      <span className="text-fg">{hovering ? "松开以导入" : "拖入文件或点击选择"}</span>
      <span className="text-ui-sm text-fg-mute">m4a / mp3 / wav / mp4 …</span>
    </button>
  );
}
