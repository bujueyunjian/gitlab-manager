import { useEffect, useState } from "react";
import type { ReadProgressState } from "./useReadProgress";
import { Loading } from "./ui";

/** Show real completed units with elapsed time; a slow request never advances the progress bar. */
export function ReadProgressView({
  title,
  progress,
}: {
  title: string;
  progress: ReadProgressState | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!progress) return <Loading>正在发起查询…</Loading>;
  const elapsed = Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  const waiting = Math.max(0, Math.floor((now - progress.updatedAt) / 1000));
  return (
    <div className="read-progress">
      <div className="read-progress-heading">
        <span role="status">
          {title} · 已处理 {progress.completed} / {progress.total} · 查询失败 {progress.failed}
        </span>
        <span className="subtle">已耗时 {elapsed} 秒</span>
      </div>
      <progress aria-label={title + "进度"} value={progress.completed} max={progress.total || 1} />
      {waiting >= 10 && progress.completed < progress.total && (
        <p className="scope-caption">最近 {waiting} 秒没有完成新项目，正在等待 GitLab 响应。</p>
      )}
    </div>
  );
}
